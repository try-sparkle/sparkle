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
// Moving agents onto an account puts it back in rotation — see `setPinFromSwitch`. `rotationState`
// imports nothing, so this cannot close a cycle.
import { setAccountInRotation } from "./rotationState";

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

/** Pre-seed Claude Code's folder-trust acceptance for `worktree` into the chosen account's config
 *  dir (or `$HOME` for the default account when `configDir` is undefined), so a worker spawned there
 *  with `--dangerously-skip-permissions` skips the "Is this a project you trust?" dialog instead of
 *  hanging on it. Call at spawn prep AFTER the account is chosen and BEFORE `buildClaudeExec`.
 *
 *  Best-effort: `--dangerously-skip-permissions` does NOT waive folder trust, so this closes the
 *  restart-wedge where a respawned worker's config dir has never trusted the (often fresh) worktree
 *  path. A failure leaves the pre-existing behavior (one trust prompt), so the caller warns and
 *  spawns anyway rather than refusing to start the worker. */
export function ensureProjectTrusted(worktree: string, configDir?: string): Promise<void> {
  return invoke("ensure_project_trusted", { worktree, configDir });
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

/** Remove an account (the Rust side refuses to remove the default; the UI also guards).
 *
 *  ALSO PRUNES THE FLEET PREFERENCE when it named this account, and only after the removal actually
 *  succeeded. This is the authoritative place for that: the spawn path sees accounts through a
 *  5-second per-window cache, so a preference set on a freshly added account can look like it names
 *  nothing there — deleting on that evidence would be a silent, irreversible write derived from a
 *  stale read (see `usablePreferredAccount`, condition 3). Here the removal is a fact. Pins are NOT
 *  pruned in the same breath: that is a pre-existing hazard with its own owner, and widening this
 *  function to fix it would hide the change. */
export async function removeAccount(id: string): Promise<void> {
  await invoke("accounts_remove", { id });
  if (getPreferredAccountId() === id) clearPreferredAccount();
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

/** Add or RENEW an account by a pasted long-lived token — a `claude setup-token` value (a
 *  `sk-ant-oat…` string that lasts ≈1 year and keeps SUBSCRIPTION billing), stored as
 *  `<configDir>/.credentials.json` (0600) by the Rust side so an agent spawned with
 *  `CLAUDE_CONFIG_DIR=configDir` authenticates with it — no interactive browser login, no 8–12h
 *  churn. The token is passed straight to Rust and never persisted on this side. The CALLER must
 *  re-probe {@link checkClaudeAuthStatus} afterwards to confirm the token actually authenticates
 *  before reporting success — this only writes the credential. */
export function setOauthToken(configDir: string, token: string): Promise<void> {
  return invoke("account_set_oauth_token", { configDir, token });
}

/** Record a token-authenticated account's identity (its `email`) so it becomes ROUTABLE. A pasted
 *  token writes only `.credentials.json`, which has no `oauthAccount.emailAddress` — the sole signal
 *  behind {@link getIdentities}/`isSignedIn`/`pickAccount` — so without this a valid token account
 *  reads "not signed in" and can never receive a spawn. Call ONLY after a live `claude auth status`
 *  confirms the login (`loggedIn && source === "cli"`), so the recorded email is one the CLI just
 *  authenticated with, never a guess. */
export function recordOauthIdentity(configDir: string, email: string): Promise<void> {
  return invoke("account_record_oauth_identity", { configDir, email });
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
 *  account is.
 *
 *  DELIBERATELY ORG-BLIND. Organization is NOT folded in here, for two reasons: (1) this key drives
 *  identity-CHANGE detection (`AccountsScreen.handleLogin`), and `organizationName` is sometimes
 *  `null` even for a completed login, so a null→named transition on ONE login would masquerade as a
 *  different account; (2) sameness-with-org is NOT transitive (a null-org row matches both a named-org
 *  row and another null one, which two different named orgs do not), and a single canonical key cannot
 *  express that. The org distinction lives in {@link duplicateAccountGroups} / {@link accountsAreSame},
 *  which compare PAIRWISE on positive evidence. */
export function identityKey(identity: Identity | undefined): string | null {
  const uuid = identity?.accountUuid ?? null;
  if (uuid) return uuid;
  const email = identity?.email ?? null;
  return email ? `email:${email}` : null;
}

/** Do two identities share an ORGANIZATION we can positively tell apart? True ONLY when both record a
 *  non-null `organization` and the two differ. A null on either side is "unknown", never a difference —
 *  the same "positive evidence only" rule {@link identitiesDiffer} uses for uuid/email.
 *
 *  This is what separates a Team org from a Personal Max under ONE email: Anthropic gives each its own
 *  `organizationName` (a team name vs the personal "<email>'s Organization"), so both are known and
 *  differ. It never splits a genuine duplicate, whose two config dirs record the same org — or, when
 *  one dir happens to report `null`, are simply not told apart here and stay merged.
 *
 *  KNOWN LIMITATION (follow-up): this compares `organization`, which is `oauthAccount.organizationName`
 *  — a mutable DISPLAY string, not a stable id. `organizationUuid` sits in the same blob but is not yet
 *  plumbed through `OauthIdentity`/`AccountIdentity`/`Identity` (Rust `accounts.rs`), so a genuine
 *  duplicate whose two config-dir caches disagree on the name after an org RENAME would read as
 *  positively-different and split. The window is narrow (both dirs must cache one login, and a rename
 *  must land between their refreshes), and the immediate case this ships for — a Team org vs a
 *  Personal Max — is separated correctly. Surfacing `organizationUuid` and preferring it here (name as
 *  fallback) is the durable fix; tracked as a follow-up bead. */
function organizationsDiffer(a: Identity | undefined, b: Identity | undefined): boolean {
  const oa = a?.organization ?? null;
  const ob = b?.organization ?? null;
  return oa != null && ob != null && oa !== ob;
}

/** Do two registered accounts denote the SAME Anthropic account — same login AND not a
 *  positively-different organization? The shared sameness test behind duplicate detection and the
 *  add/relogin guards.
 *
 *  Same login is {@link identityKey} equality (uuid, else verified email). On top of that, two
 *  accounts that share a login but sit in DIFFERENT known organizations (a Team org vs a Personal Max
 *  under one email) are NOT the same account — they hold separate quotas. Org can only SPLIT a shared
 *  login, never join two different ones, so an unknown (null) org leaves the login verdict untouched. */
export function accountsAreSame(a: Identity | undefined, b: Identity | undefined): boolean {
  const ka = identityKey(a);
  if (ka == null) return false; // no resolvable login → never "the same" as anything
  return ka === identityKey(b) && !organizationsDiffer(a, b);
}

/** Do two identities denote DIFFERENT Anthropic accounts? TS mirror of Rust
 *  `accounts::identities_differ`.
 *
 *  The uuid decides when BOTH sides have one; otherwise fall back to the email. A bare `!==` on the
 *  uuids reads `null !== "x"` as a difference and INVENTS one — which, on the fork notice, means
 *  telling the user their terminal is on a different account when it may well be the same. Never
 *  claims a difference it cannot show.
 *
 *  ORGANIZATION-BLIND (known limitation, follow-up). This compares only uuid/email, so it does NOT see
 *  the Team-org-vs-Personal-Max-under-one-email split that `organizationsDiffer` / `accountsAreSame`
 *  now draw. Its one consumer is `accountDisplay.shellForked` (the default account's fork notice), so
 *  a default account on the Team org whose login SHELL is signed into the Personal Max reads as "same
 *  account" (no fork surfaced) even though the quotas differ. Routing `shellForked` through
 *  `accountsAreSame` would fix it, but the shell side carries no organization: `AccountIdentity` has
 *  `shell_email`/`shell_account_uuid` but no `shell_organization` (Rust `accounts.rs`), so there is no
 *  org to compare until that is plumbed. Deferred to the same `organizationUuid` follow-up; the fork
 *  notice is advisory (it never gates spawning), so the miss is a missing hint, not a wrong action. */
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

/** Ids of DEFAULT accounts that are CLOBBERED — the shared `$HOME/.claude` folder whose on-disk login
 *  is now a different Anthropic account than the one Sparkle runs it as ({@link accountDisplay}'s
 *  `shellForked`), or one whose dir a different account signed into recently ({@link identityChanged}).
 *
 *  This is the exact fragility the founder hits: the default is shared with the terminal `claude` CLI,
 *  so a terminal login clobbers the OAuth Sparkle expects, yet recorded state still reads the account
 *  as signed-in and healthy. Feed this set to {@link PickOptions.clobberedIds} so auto-pick prefers a
 *  dedicated account and routes AWAY from a clobbered default — while `leastBad` still falls back to it
 *  when it is genuinely the only account (see PickOptions.clobberedIds).
 *
 *  Scoped to `isDefault` deliberately: `shellForked` is a default-only signal, and a named dedicated
 *  account is not shared with the terminal, so it cannot be clobbered this way. */
export function clobberedDefaultIds(
  accounts: Account[],
  identities: Identity[] | undefined,
): Set<string> {
  const byId = new Map((identities ?? []).map((i) => [i.id, i]));
  const out = new Set<string>();
  for (const a of accounts) {
    if (!a.isDefault) continue;
    const identity = byId.get(a.id);
    if (accountDisplay(a, identity).shellForked || identityChanged(identity)) out.add(a.id);
  }
  return out;
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
  // groups whenever one registration reports an `accountUuid` and its twin does not - the modern
  // client records the field, an older login in another config dir does not. `siblingMap` is
  // derived from these groups, so a split means only one of the pair gets benched when their SHARED
  // quota runs out, and auto-pick immediately routes work back into the exhausted account. That is
  // precisely the failure this function exists to prevent (knightwatch probe 1).
  const groups = new Map<string, DuplicateGroup>();
  const emailToUuidKeys = new Map<string, Set<string>>();

  // Pass 1 - every row that HAS a uuid. The uuid is the authoritative discriminator.
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

  // Pass 2 - rows with an email but no uuid. Merge into a uuid group ONLY when that email
  // identifies exactly one such group: with two, the email is ambiguous (it genuinely maps to more
  // than one Anthropic account) and guessing would bench an account that is not actually a sibling,
  // which is worse than missing the pairing. Otherwise they group among themselves by email.
  for (const a of accounts) {
    const identity = byId.get(a.id);
    if (identity?.accountUuid) continue;
    const email = identity?.email;
    if (!email) continue; // no login at all -> not comparable
    const candidates = emailToUuidKeys.get(email);
    if (candidates && candidates.size > 1) {
      // AMBIGUOUS, so this row is not grouped AT ALL - not with a uuid group, and not with the
      // other refused rows either. Falling through to email bucketing here was a real bug: given
      // a(u1,X) b(u2,X) c(no-uuid,X) d(no-uuid,X), c and d landed in one `email:X` group of two,
      // which survives the length filter. That is the SAME unfounded guess the line above just
      // declined - c may be u1 and d may be u2 - except this branch actually produces a group, so
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

  // ORGANIZATION SPLIT. The passes above grouped by LOGIN (uuid/email). One login can nonetheless
  // front TWO distinct Anthropic accounts - a Team org and a Personal Max under ONE email - which
  // share an `accountUuid` but hold SEPARATE quotas, so they must not read as one "duplicate".
  // `splitGroupByOrganization` splits a group only when it holds two or more POSITIVELY-DIFFERENT
  // organizations (both known and differing); a `null` org is "unknown", never a difference, so a
  // genuine duplicate - same login, matching orgs, or where one dir reports null - is never split.
  // Only a real Team-vs-Personal divergence is (the founder's `amforge` case).
  return [...groups.values()].flatMap((g) => splitGroupByOrganization(g, byId));
}

/** Split one login-group into per-organization groups when — and only when — it holds two or more
 *  POSITIVELY-DIFFERENT organizations. Returns the group unchanged (still filtered to >= 2 members)
 *  when there is at most one known org, so a genuine duplicate is never broken apart.
 *
 *  Rows whose org is `null` are "unknown": with a single known org they stay with the group; with two
 *  or more they are UNATTRIBUTABLE and are not grouped at all (each becomes a singleton and drops on
 *  the length filter). This is deliberate, and it is the SAME refusal-to-guess the ambiguous-email
 *  guard makes (roborev 58175): the ≥2-known-orgs premise is precisely "one `accountUuid` fronts two
 *  DIFFERENT accounts", so a null-org row is NOT a proven sibling of any particular sub-group — it may
 *  be the Team's or the Personal's, and we cannot tell. Pairing two such rows into a duplicate group
 *  would be a positively wrong claim: the banner would tell the user to remove one of two independent
 *  accounts, `siblingMap` would bench the healthy one when the other walls, and
 *  `switchRecommendation`'s same-login exclusion would drop a real escape target.
 *
 *  KNOWN LIMITATION (follow-up, bead sparkle-hli8pu). The refusal to pair is the SAFE direction for
 *  the duplicate BANNER (never claim two independent accounts are one), but this strict result feeds
 *  THREE consumers and the other two have the opposite safe direction:
 *   - `siblingMap` (benching): a null-org row that really IS a duplicate of one sub-group goes
 *     un-benched, so it is not fanned an `exhaustedUntil` when its true twin walls.
 *   - `switchRecommendation`'s `sameLoginAsFrom` (switch-target exclusion): the same row is not
 *     excluded, so it can be OFFERED as the escape route from its walled twin and auto-migrated onto —
 *     the shared quota. The live-usage exclusion ({@link loginLiveWorstPercent}) is judged per LOGIN,
 *     but this ungrouped row is in NO login group, so it is judged on its OWN dir's live row alone —
 *     masked only when that row's own fetch succeeded at ≥ {@link LIVE_AVOID_PERCENT}. Offline / 401 /
 *     before the first poll it is unmasked, and the observed wall is the only backstop left (it fans
 *     across `siblingMap`, which does not contain the row either).
 *  The correct fix is a SEPARATE inclusive "possible-sibling" relation for those two consumers
 *  (a null-org row counts as a possible sibling of every sub-group of its login), kept distinct from
 *  this strict banner result — but it must NOT exclude a KNOWN-different-org account (that would break
 *  the Team→Personal switch the whole feature exists for), so it needs `organizationUuid` to draw the
 *  line safely. Deferred to sparkle-hli8pu. This is the {@link organizationsDiffer} "positive evidence
 *  only" rule applied to a whole group: a Team org and a Personal Max under one email split apart;
 *  two config dirs holding the SAME login (orgs match, or ≤1 known org) stay one group. */
function splitGroupByOrganization(
  group: DuplicateGroup,
  byId: Map<string, Identity>,
): DuplicateGroup[] {
  const orgOf = (a: Account): string | null => byId.get(a.id)?.organization ?? null;

  const knownOrgs = new Set<string>();
  for (const a of group.accounts) {
    const org = orgOf(a);
    if (org != null) knownOrgs.add(org);
  }
  // At most one distinct known org -> nothing to tell apart; keep the group whole.
  if (knownOrgs.size <= 1) return group.accounts.length > 1 ? [group] : [];

  // Two or more known orgs -> the login fronts distinct accounts. Bucket each NAMED-org row by its
  // org; UNKNOWN-org rows are unattributable (see the docblock) and are left ungrouped — each falls
  // out of the group as its own singleton on the length filter below. We do NOT pair unknown-org rows
  // with each other: that is the roborev-58175 wrong-pairing, one axis over.
  const byOrg = new Map<string, DuplicateGroup>();
  for (const a of group.accounts) {
    const org = orgOf(a);
    if (org == null) continue;
    const sub = byOrg.get(org);
    if (sub) sub.accounts.push(a);
    else
      byOrg.set(org, {
        key: `${group.key}::org:${org}`,
        accountUuid: group.accountUuid,
        email: group.email,
        accounts: [a],
      });
  }
  return [...byOrg.values()].filter((g) => g.accounts.length > 1);
}

/** Ids of accounts that duplicate another account's login (flattened {@link duplicateAccountGroups}). */
export function duplicateAccountIds(accounts: Account[], identities: Identity[]): Set<string> {
  return new Set(
    duplicateAccountGroups(accounts, identities).flatMap((g) => g.accounts.map((a) => a.id)),
  );
}

/** id → all account-ids that share its LOGIN (the flattened {@link duplicateAccountGroups}). An
 *  ungrouped account is absent (callers default it to `[id]`). Built ONCE by a caller and threaded
 *  into the three consumers of the live-usage signal ({@link pickAccount}/`partitionAccounts`,
 *  `headroom.exhaustionOutlook`, `headroom.switchRecommendation`) so they judge live-spent PER LOGIN
 *  and cannot contradict each other — see {@link loginLiveWorstPercent}. */
export function loginSiblingIds(
  accounts: Account[],
  identities: Identity[],
): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const g of duplicateAccountGroups(accounts, identities)) {
    const ids = g.accounts.map((a) => a.id);
    for (const id of ids) m.set(id, ids);
  }
  return m;
}

/** The worst real-Anthropic utilization across an account's whole LOGIN group, or null when no row in
 *  the group was reported. A QUOTA belongs to a login, not a config dir: `refreshLiveUsage` fetches
 *  per registration and a failed fetch (401 / keychain declined / offline) simply has no row, so one
 *  registration of a spent login can read 99% while its twin reads nothing. Taking the MAX over the
 *  login group makes the twin count as spent too — exactly as `limitSync.pendingExhaustions` fans an
 *  OBSERVED wall across `siblingMap`, but WITHOUT waiting for the wall. `siblingIds` absent, or an
 *  account not in it, falls back to the single dir (`[id]`), i.e. plain per-dir behaviour. */
export function loginLiveWorstPercent(
  id: string,
  liveById: ReadonlyMap<string, LiveUsage>,
  siblingIds?: ReadonlyMap<string, readonly string[]>,
): number | null {
  const ids = siblingIds?.get(id) ?? [id];
  let worst: number | null = null;
  for (const sid of ids) {
    const p = liveWorstPercent(liveById.get(sid));
    if (p != null && (worst == null || p > worst)) worst = p;
  }
  return worst;
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

/** RETIRED as a gate. This was the fraction of an account's LEARNED ceiling at or above which new
 *  spawns stopped landing on it ("stops taking new agents at 90%") — but the founder retired the
 *  learned-ceiling ESTIMATE as a driver of UI and behaviour: it fired "90% of its usual limit" on
 *  accounts whose REAL Anthropic session/weekly numbers were clear. Proactive spawn avoidance is now
 *  driven by Anthropic's own utilization ({@link LIVE_AVOID_PERCENT}), with the observed wall
 *  (`exhaustedUntil`) as the reactive backstop.
 *
 *  The constant is kept for reference (several docblocks below cite it, and `headroom.ts` still
 *  describes the old two-stage WARN/ACT design in prose) but nothing reads it any more. Do NOT wire
 *  it back into `partitionAccounts` or `switchRecommendation` without the founder — that is exactly
 *  the estimate-driven behaviour that was removed. */
export const CEILING_AVOID_FRACTION = 0.9;

/** `tokens5h` as a fraction of this account's learned ceiling, or null when we can't say.
 *
 *  Null is a real answer and must never be coerced to 0: an account with too few observed limit
 *  episodes has `ceiling: null`, and treating that as "0% used" would make an unmeasured account
 *  look like the emptiest one in the pool and win every pick.
 *
 *  Deliberately NOT imported from `headroom.ts`, which computes the same ratio for the banner. That
 *  module imports VALUES from this one, so importing back would be a runtime cycle on the spawn
 *  path. `headroom.test.ts` and `accountStore.test.ts` each pin the ratio, and the shared constant
 *  above is what keeps the two thresholds from drifting. */
function ceilingFraction(u: Usage, ceiling: number | null | undefined): number | null {
  if (ceiling == null || ceiling <= 0) return null;
  return u.tokens5h / ceiling;
}

/** REAL server-side utilization for one account, as Anthropic reports it (Rust `AccountUsageLive`,
 *  from `GET /api/oauth/usage`). Percentages, 0–100.
 *
 *  Both fields are `number | null` rather than optional, because the wire genuinely sends `null` for
 *  a window that is absent — a Rust `Option` crosses as the key with a null VALUE, never as a
 *  missing key. `null` means "Anthropic did not tell us", which is NOT the same as 0 and must never
 *  be coerced to it: that coercion is the entire bug this type exists to fix. */
export interface LiveUsage {
  id: string;
  fiveHourPercent: number | null;
  sevenDayPercent: number | null;
}

/** Utilization (percent of Anthropic's OWN limit) at or above which an account stops receiving new
 *  spawns.
 *
 *  Distinct from {@link CEILING_AVOID_FRACTION} in WHAT IT MEASURES, even though the two now coincide
 *  numerically (both effectively 0.9). That one is a fraction of a LEARNED ceiling — an estimate with
 *  a measured CoV of 0.24 — so its value is a hedge against estimation error. This is Anthropic's OWN
 *  number for its own limit, a FACT rather than an estimate, so the same 90 here is not a hedge but a
 *  chosen buffer: how far below the real wall the founder wants the fleet to move.
 *
 *  90, lowered from 95 at the founder's instruction (2026-08-21): an account reached 92% under the
 *  old bar without the fleet switching, which read as rotation not working. Moving the fleet off at
 *  90 gives a wider buffer before a hard limit — the founder's priority is not hitting limits while
 *  away — and matches the threshold he expected. The 10-point margin still covers the usage endpoint
 *  lagging the spend a running agent is generating right now. */
export const LIVE_AVOID_PERCENT = 90;

/** The higher of an account's two live windows, or null when neither was reported.
 *
 *  The MAX, not the 7-day figure alone: an account at 0% weekly but 100% of its 5-hour session is
 *  just as unable to take a spawn right now. The founder's measured card showed exactly this split
 *  (session 0%, weekly 100%), so reading either window on its own would have missed one of them. */
export function liveWorstPercent(l: LiveUsage | undefined): number | null {
  if (!l) return null;
  const vals = [l.fiveHourPercent, l.sevenDayPercent].filter((v): v is number => v != null);
  return vals.length === 0 ? null : Math.max(...vals);
}

export interface PickOptions {
  /** Manual per-agent override. If set and it names an existing account, that account wins
   *  unconditionally (even if exhausted/near-cap/not signed in) — a human chose it on purpose. */
  pinnedAccountId?: string;
  /** Soft window ceilings; defaults to {@link DEFAULT_NEAR_CAP}. */
  nearCap?: NearCap;
  /** Per-account LEARNED ceilings (Rust `accounts_ceilings`).
   *
   *  NO LONGER GATES AUTO-PICK. An account at or above {@link CEILING_AVOID_FRACTION} of its ceiling
   *  used to be excluded here — the proactive "switch before the wall" half of rotation — but the
   *  founder retired the learned-ceiling estimate as a driver (it fired "close to its limit" while
   *  the real Anthropic figures were clear). Proactive avoidance is now {@link PickOptions.live}
   *  (Anthropic's own number); the observed `exhaustedUntil` is the reactive backstop.
   *
   *  Still consumed for ONE thing: ranking the all-excluded FALLBACK (see `leastBad`), where a
   *  genuinely rate-limited account should sort behind a merely near-ceiling one. Omitting it leaves
   *  that fallback ranked by raw usage instead. */
  ceilings?: readonly Ceiling[];
  /** Ids of accounts that are actually `claude login`ed (see {@link signedInAccountIds}). When
   *  supplied and at least one listed account matches, auto-pick considers ONLY these. Omit (or pass
   *  a set matching no account) to skip the filter entirely — see the rationale on `pickAccount`. */
  signedInIds?: readonly string[];
  /** REAL per-account utilization from Anthropic. When supplied, this OUTRANKS the local token
   *  tally for every account it covers — see {@link pickAccount} — and, at/above
   *  {@link LIVE_AVOID_PERCENT}, is the ONLY proactive exclusion (the learned-ceiling gate is gone).
   *
   *  It exists because the local tally and the truth can disagree completely, and did: an account
   *  reading 100% of its weekly limit server-side had a LOCAL tally of zero, because the tally is
   *  computed by scanning that account's own transcripts and this machine had run none of its work.
   *  Zero tokens is the most headroom there is, so the single most exhausted account on the machine
   *  won auto-pick for every spawn. Omitting this leaves selection exactly as it was.
   *
   *  WHEN A LIVE ROW IS MISSING (background cache not warmed yet, offline, 401, keychain declined),
   *  there is NO proactive exclusion for that account — it is judged by lowest local tally with the
   *  OBSERVED wall (`exhaustedUntil`) as the only backstop. The retired learned ceiling is NOT used
   *  to fill that window on purpose: it is computed from the SAME local transcripts that read zero
   *  for a fully-spent account on the founder's machine, so leaning on it here would reinstate the
   *  exact unreliable estimate the founder removed. The observed wall is the reliable local signal. */
  live?: readonly LiveUsage[];
  /** id → all account-ids sharing its LOGIN (see {@link loginSiblingIds}). When supplied, the live
   *  exclusion is judged PER LOGIN (max real utilization across the group) rather than per config
   *  dir, so a duplicate of an already-spent login whose OWN live fetch failed is still excluded —
   *  and this matches the same per-login judgement `exhaustionOutlook` / `switchRecommendation` use,
   *  so the spawn gate cannot disagree with them. Omit for plain per-dir behaviour. */
  siblingIds?: ReadonlyMap<string, readonly string[]>;
  /** Ids of accounts to treat as unhealthy for AUTO-PICK because they are CLOBBERED — the shared
   *  `$HOME/.claude` default whose on-disk login is now a DIFFERENT Anthropic account than the one
   *  Sparkle runs it as, or a config dir a different account signed into recently (see
   *  {@link clobberedDefaultIds}). Recorded state still reads such an account as "signed in / healthy",
   *  so nothing else excludes it, yet routing to it authenticates as the wrong account or dies on an
   *  OAuth mismatch — the concierge's shared-default fragility.
   *
   *  Excluded from `candidates` exactly like an exhausted account, so a healthy DEDICATED account is
   *  preferred. It is NEVER removed from `eligible`, so when a clobbered account is the ONLY option
   *  `leastBad` still returns it: a login prompt on the fragile default beats no account at all. Opt-in
   *  per caller — omit it and behaviour is unchanged, which is why only the concierge passes it today. */
  clobberedIds?: ReadonlySet<string>;
  /** Ids of accounts whose identity WAS read and came back with no login at all (see
   *  {@link notSignedInAccountIds}). This is a POSITIVE reading — "we opened this config dir and
   *  there is no authenticated account in it" — and it is a different fact from "we have no reading
   *  for this account", which is what an absent id means.
   *
   *  It exists because the signed-in filter degrades OPEN: when no listed account resolves as signed
   *  in, {@link signedInFilterApplies} reports no usable signal and `eligible` becomes the FULL list
   *  rather than blocking the spawn. That is the right call — better a login prompt than a dead
   *  agent — but on its own it is worse than it needs to be, because auto-pick ranks on the LOCAL
   *  token tally and a config dir that was never `claude login`ed has no transcripts. Its tally is
   *  zero, which is the most headroom of all, so the never-logged-in dir does not merely survive the
   *  degraded filter: it WINS, for every agent at once. That is sparkle-gms0's trap re-entering
   *  through the degradation path.
   *
   *  Excluded from `candidates` exactly like an exhausted or clobbered account, and — for the same
   *  reason — NEVER removed from `eligible`, so when every account reads unauthenticated `leastBad`
   *  still returns one and no spawn is blocked. When the signed-in filter DOES apply this set has no
   *  effect: those accounts are already absent from `eligible`. Absent the option nothing changes. */
  unauthedIds?: ReadonlySet<string>;
  /** Ids the user has explicitly taken OUT of rotation from the accounts screen's kebab (see
   *  `services/rotationState.rotationOutIds`).
   *
   *  This is the only exclusion on this interface that is a HUMAN CHOICE rather than a reading of the
   *  world, and it is wired here rather than left in the UI on purpose: a dot that says "out of
   *  rotation" over an account that keeps receiving agents would be a worse lie than the green dot it
   *  replaced. The founder asked for the toggle precisely so he could steer the fleet.
   *
   *  Demotes exactly like {@link PickOptions.clobberedIds} — dropped from `candidates`, NEVER from
   *  `eligible` — so a user who takes every account out of rotation gets `leastBad` rather than a
   *  fleet that silently stops spawning. Taking accounts out is a preference; turning the machine off
   *  is not what the control says it does. Absent the option nothing changes.
   *
   *  NOT PASSED FOR A STICKY KEY. `accountSelection.chooseAccountForAgent` omits it when the caller is
   *  the concierge or Improve Sparkle, because this set also reaches the branch that decides whether a
   *  sticky key KEEPS its account — and relocating one mid-conversation nulls both session pointers
   *  and re-probes, with no stale-resume retry. A kebab click must not be able to do that; only
   *  observed facts (a rate limit, real utilization) relocate a sticky consumer. */
  outOfRotationIds?: ReadonlySet<string>;
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

/** The ids of accounts whose identity was READ and carries no login — the exact complement of
 *  {@link signedInAccountIds} over the identities we actually have. Feed this to
 *  {@link PickOptions.unauthedIds}.
 *
 *  The distinction that makes this worth deriving separately: an account MISSING from `identities`
 *  is unknown (never read, read failed, arrived after the snapshot), while an account PRESENT with
 *  `email: null` has been read and positively has no `oauthAccount` to run as. Only the second is
 *  evidence, and the degraded-filter path needs evidence — the whole reason it degrades open is that
 *  it cannot tell those two apart from `signedInIds` alone. */
export function notSignedInAccountIds(identities: Identity[]): string[] {
  return identities.filter((i) => i.email == null).map((i) => i.id);
}

/** Does the signed-in reading carry a USABLE signal — i.e. does it name at least one account that
 *  actually exists? THE one definition of "the signed-in filter applies", shared by every gate that
 *  degrades on an absent signal, so they cannot disagree about what an empty reading means.
 *
 *  The distinction that makes this a function rather than `signedInIds.length > 0`: an id can be
 *  present in the reading and name NO existing account. `signedInAccountIds` is derived from
 *  identities, which are read per config dir and can outlive the account row they describe — a
 *  deleted or renamed account leaves a stale identity behind. Length alone counts that ghost as a
 *  usable signal; membership does not.
 *
 *  That gap was a live divergence. `partitionAccounts` has always keyed on membership (its
 *  `authed.length > 0`), while the preferred-account gate and the fleet-holder scan keyed on raw
 *  length — so on an install whose only signed-in identity was stale, the spawn pool opened to every
 *  account (membership: no signal) while those two gates simultaneously rejected every account
 *  (length: signal present, nothing matches it). The founder's explicitly preferred account was
 *  dropped on every spawn, silently, with the ledger recording a bland "auto". */
export function signedInFilterApplies(
  accounts: readonly { id: string }[],
  signedInIds: readonly string[] | undefined,
): boolean {
  if (!signedInIds || signedInIds.length === 0) return false;
  const ids = new Set(signedInIds);
  return accounts.some((a) => ids.has(a.id));
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
 *  loaded yet, or an IPC hiccup returning []), the filter is skipped rather than blocking spawns.
 *
 *  That degradation is deliberate and stays — better a login prompt than a dead agent — but skipping
 *  the filter is not the same as forgetting what was read. `unauthedIds` carries the accounts whose
 *  identity came back with NO login, and those are demoted out of `candidates` even while the filter
 *  is skipped, so the trap above cannot re-enter through the degraded path: the never-logged-in dir
 *  no longer wins on its zero tally just because the signal that would have excluded it was
 *  unusable. It is a demotion, not a block — `eligible` still holds them, so an install where every
 *  account reads unauthenticated still spawns. See {@link PickOptions.unauthedIds}. */
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
  const ceilingFor = ceilingLookup(opts.ceilings);
  const now = opts.now ?? Date.now();

  if (candidates.length === 0) {
    // Everyone is exhausted / near-cap: fall back rather than block, because refusing to spawn on an
    // ESTIMATE would let a mis-learned ceiling halt the fleet.
    //
    // Which one, though. This used to prefer the DEFAULT account, and that is precisely backwards
    // under rotation: the default is the account everything lands on by default, so it is the most
    // likely to be the one that just ran out — on the machine this was written for, the default
    // (`DROdio Personal`) was the account carrying an `exhaustedUntil` at the time. Falling back to
    // it sends the whole fleet at the deadest account in the pool.
    //
    // So: LEAST-BAD, ranked by the same evidence used to exclude them. A genuinely rate-limited
    // account still sorts behind a merely near-cap one, since `exhaustedUntil` is observed fact
    // while the ceiling is an estimate.
    return leastBad(eligible, usageFor, ceilingFor, now);
  }

  // Lowest rank wins — Anthropic's real utilization where we have it, the local 7d/5h tally where we
  // do not. Stable: equal entries keep input order, since a tie returns `best`.
  const liveFor = liveLookup(opts.live);
  return candidates.reduce((best, a) =>
    compareRank(pickRank(a, usageFor, liveFor), pickRank(best, usageFor, liveFor)) < 0 ? a : best,
  );
}

/** Is this usage row an OBSERVED rate limit that has not yet reset? The single definition of
 *  "exhausted" in this module — {@link partitionAccounts} and the exported
 *  {@link isAccountExhausted} both call it, so eligibility and the preferred-account gate can never
 *  answer the same question two different ways. A missing row is "nothing observed", not exhausted. */
function usageExhausted(u: Usage | undefined, now: number): boolean {
  return u?.exhaustedUntil != null && u.exhaustedUntil > now;
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
  const signedIn = new Set(signedInIds ?? []);
  const eligible = signedInFilterApplies(accounts, signedInIds)
    ? accounts.filter((a) => signedIn.has(a.id))
    : accounts;

  const usageFor = usageLookup(usage);
  const isExhausted = (u: Usage) => usageExhausted(u, now);
  // The static token cap, still defaulting to no cap at all (see DEFAULT_NEAR_CAP).
  //
  // THE LEARNED-CEILING GATE IS GONE. An account at >= CEILING_AVOID_FRACTION of its ESTIMATED
  // ceiling used to be excluded here — the "stops taking new agents at 90%" behaviour the account
  // card described. The founder retired that estimate as a driver: it fired "90% of its usual
  // limit" on accounts whose REAL Anthropic session/weekly numbers were clear, steering new spawns
  // off healthy accounts. Proactive avoidance is now driven by Anthropic's OWN number (`isLiveSpent`
  // below), with the observed wall (`isExhausted`) as the reactive backstop — fact, not estimate.
  const isNearStaticCap = (u: Usage) =>
    u.tokens5h >= nearCap.tokens5h || u.tokens7d >= nearCap.tokens7d;

  // ANTHROPIC'S OWN NUMBER — the real per-account utilization, and the source of truth for proactive
  // avoidance now that the learned-ceiling estimate no longer gates. The token-based static cap is
  // computed from local transcripts, which is why it cannot see this case at all: an account whose
  // work ran on another machine has a local tally of zero however spent it really is.
  //
  // `null` (window not reported, or no live row for this account) is NOT an exclusion — an
  // unreadable figure must never look like a full one, exactly as it must never look like an empty
  // one. It simply leaves the account to be judged by the tests above.
  // Judged PER LOGIN when `siblingIds` is supplied (max real utilization across the login group), so
  // a duplicate of a spent login whose own fetch failed is still excluded and this gate agrees with
  // `exhaustionOutlook` / `switchRecommendation`. Absent it, this is plain per-dir.
  const isLiveSpent = (a: Account) => isAccountLiveSpent(a.id, opts.live, opts.siblingIds);
  // A clobbered account (see PickOptions.clobberedIds) is unhealthy for auto-pick but stays in
  // `eligible`, so `leastBad` can still return it when it is the only account (a login prompt on the
  // fragile default beats a dead agent). Absent the option this set is empty and nothing changes.
  const isClobbered = (a: Account) => opts.clobberedIds?.has(a.id) ?? false;
  // Positively read as having no login (see PickOptions.unauthedIds). Only ever reachable when the
  // signed-in filter degraded open, since otherwise these accounts are not in `eligible` at all —
  // and it is exactly there that it matters, because a never-logged-in dir's zero tally would
  // otherwise make it the TOP pick for every agent. Like `isClobbered`, it demotes rather than
  // blocks: `eligible` keeps it, so `leastBad` still has something to return.
  const isUnauthed = (a: Account) => opts.unauthedIds?.has(a.id) ?? false;
  // Taken out of rotation BY THE USER (see PickOptions.outOfRotationIds). Demotes rather than
  // blocks, for the same reason as the two above: `eligible` keeps it, so taking every account out
  // still leaves `leastBad` something to return. The screen's dot reads off the same set, so a row
  // saying "out of rotation" and a spawn landing on it cannot both happen.
  const isOutOfRotation = (a: Account) => opts.outOfRotationIds?.has(a.id) ?? false;

  const candidates = eligible.filter((a) => {
    const u = usageFor(a);
    return (
      !isExhausted(u) &&
      !isNearStaticCap(u) &&
      !isLiveSpent(a) &&
      !isClobbered(a) &&
      !isUnauthed(a) &&
      !isOutOfRotation(a)
    );
  });
  return { eligible, candidates };
}

/** Live-usage row per account id, or undefined when there is none. */
function liveLookup(live: readonly LiveUsage[] | undefined): (a: Account) => LiveUsage | undefined {
  const byId = new Map((live ?? []).map((l) => [l.id, l]));
  return (a: Account) => byId.get(a.id);
}

/** Sort key for auto-pick, lowest wins. A TOTAL order in two tiers, which is what keeps the two
 *  incomparable units from being compared.
 *
 *  Tier 0 — accounts Anthropic gave us a real figure for, ranked by that figure.
 *  Tier 1 — accounts it did not, ranked by the local token tally as before.
 *
 *  Tier 0 sorts ahead of tier 1 wholesale, and that ordering is deliberate rather than incidental: a
 *  verified 20% is better evidence of headroom than an unverified zero, and preferring what we can
 *  actually check is the safer bias. It also degrades correctly at both ends — with no live data at
 *  all every account lands in tier 1, which is exactly the behaviour that shipped before, and with
 *  live data for everything tier 1 is empty.
 *
 *  Percent and tokens never meet inside a comparison: two tier-0 accounts compare percentages, two
 *  tier-1 accounts compare tokens, and a cross-tier pair is decided by the tier alone. */
function pickRank(
  a: Account,
  usageFor: (a: Account) => Usage,
  liveFor: (a: Account) => LiveUsage | undefined,
): [number, number, number] {
  const p = liveWorstPercent(liveFor(a));
  if (p != null) {
    const l = liveFor(a);
    // Secondary key is the OTHER window's figure, so two accounts tied on their worst window are
    // still separated by the one with more room on the other.
    const other = Math.min(l?.fiveHourPercent ?? p, l?.sevenDayPercent ?? p);
    return [0, p, other];
  }
  const u = usageFor(a);
  return [1, u.tokens7d, u.tokens5h];
}

/** Lexicographic compare of two {@link pickRank} keys. */
function compareRank(x: [number, number, number], y: [number, number, number]): number {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The best of a bad pool, when every account is exhausted or near its ceiling.
 *
 *  Ordered on the strength of the evidence, worst-evidence-last:
 *   1. NOT currently rate-limited beats currently rate-limited. `exhaustedUntil` is an observed
 *      failure; the ceiling is an estimate, and an estimate never outranks a fact.
 *   2. Within a tier, lower fraction-of-own-ceiling wins — the account with the most real room.
 *   3. An account with no learned ceiling sorts behind every quantified one, ordered among its peers
 *      by raw 5h usage. Same rule as `headroom.headroomRank`, and for the same reason: "unknown" is
 *      not evidence of room, so it must not beat a measured 91%.
 *   4. On an EXACT tie, the default account. This is all that remains of the old rule, and the
 *      demotion is the point: when the pool is genuinely indistinguishable (every account limited,
 *      no usage recorded) the default is as good a choice as any, so nothing is gained by changing
 *      it. What must not happen is the default winning over an account with real headroom, which is
 *      what the old unconditional preference did.
 *
 *  Stable: equal entries keep input order. */
function leastBad(
  eligible: Account[],
  usageFor: (a: Account) => Usage,
  ceilingFor: (a: Account) => number | null,
  now: number,
): Account {
  const rank = (a: Account): [number, number, number, number] => {
    const u = usageFor(a);
    const limited = u.exhaustedUntil != null && u.exhaustedUntil > now ? 1 : 0;
    const f = ceilingFraction(u, ceilingFor(a));
    // KNOWN-vs-UNKNOWN IS ITS OWN TIER, not a number folded into the score.
    //
    // It was folded in, by mapping unknowns into [1, 2) on the premise that a real fraction "tops
    // out near 1". That premise is false precisely here (roborev 59923): the ceiling is the MEDIAN
    // 5h consumption at past limit episodes, so by construction about half of all limit episodes sit
    // ABOVE it — `f > 1` is the ordinary case in the very fallback this function serves. So a
    // measured account at 1.2 lost to an unknown one whose only evidence was a low tally, and
    // `usageLookup` synthesises a ZERO row for an account with no usage entry at all, meaning a
    // completely unmeasured account could win the fallback outright.
    //
    // As separate tiers the documented rule actually holds: every quantified account sorts ahead of
    // every unquantified one, and raw usage only orders the unquantified among themselves.
    const known = f != null;
    return [limited, known ? 0 : 1, known ? f : u.tokens5h, a.isDefault ? 0 : 1];
  };
  // eligible is non-empty at every call site (pickAccount guards `accounts.length === 0`).
  return eligible.reduce((best, a) => {
    const ra = rank(a);
    const rb = rank(best);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return (ra[i] as number) < (rb[i] as number) ? a : best;
    }
    return best;
  }, eligible[0] as Account);
}

/** Learned ceiling per account id. Missing entries and explicit nulls both read as "unknown". */
function ceilingLookup(
  ceilings: readonly Ceiling[] | undefined,
): (a: Account) => number | null {
  if (!ceilings || ceilings.length === 0) return () => null;
  const byId = new Map(ceilings.map((c) => [c.id, c.ceiling ?? null]));
  return (a) => byId.get(a.id) ?? null;
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

/** Pin `agentId` to `accountId` (manual override for all of this agent's future spawns).
 *
 *  A HUMAN PIN, and the provenance mark is dropped to say so: if a switch had written this agent's
 *  pin earlier, the person overriding it now owns the choice, and `clearSwitchWrittenPins` must stop
 *  treating it as machinery's to discard. */
export function setPin(agentId: string, accountId: string): void {
  const m = readPins();
  m.set(agentId, accountId);
  writePins(m);
  unmarkSwitchWritten(agentId);
}

/** Pin `agentId` as part of an automated MIGRATION, recording that the machinery wrote it.
 *
 *  The distinction exists because "Activate this account" has to clear the pins a PREVIOUS
 *  activation left behind — otherwise an agent pinned by the last switch and no longer mounted can
 *  never be re-pinned, and it outranks the fleet preference forever (see `clearSwitchWrittenPins`).
 *  Sweeping by any broader rule would take the user's own pins with it: `AgentPane` exposes an
 *  account picker whose comment calls it a "manual override", and `chooseAccountForAgent` honours a
 *  pin over every judgement it makes precisely because a human chose it on purpose. One click on
 *  Activate must not delete that, in every project and every window. */
export function setPinFromSwitch(
  agentId: string,
  accountId: string,
  /** Is this pin part of a RELOCATION — is the agent arriving from somewhere else?
   *
   *  Only a relocation revises the rotation pool (see below). The other caller is
   *  `authRecovery.resumeAll`, which re-pins a stuck agent to the account it is ALREADY on so the
   *  re-spawn cannot auto-pick a different, still-walled one. Nothing moves there, and nothing is
   *  said about the fleet — so revising the user's statement about the pool off that gesture is the
   *  same overreach the `setPin` exemption below exists to avoid. Defaults to false, so a new caller
   *  has to opt IN to changing the pool rather than doing it by accident. */
  relocating = false,
): void {
  setPin(agentId, accountId); // clears the mark…
  const marked = readSwitchWritten();
  marked.add(agentId); // …and this puts it back, so the two calls cannot drift
  writeSwitchWritten(marked);
  // RELOCATING AGENTS ONTO AN ACCOUNT PUTS IT BACK IN ROTATION, and this is the right place for that
  // rule rather than any of the four callers.
  //
  // Pins are deliberately EXEMPT from `outOfRotationIds` — a human naming one agent and one account
  // outranks a statement about the rotation pool. That exemption is what makes a migration onto an
  // opted-out account possible, and the resulting state is the dot-contradicts-the-router failure
  // this whole surface was rebuilt to remove: the card reads "out of rotation · you took it out"
  // while the machinery re-pins running agents there. Enumerating the callers was tried and is
  // fragile — the accept path and the stranded-helper rescue deliberately write no preference, so a
  // fix hung off `recordActivation` skips exactly them, and whether the card ever flipped depended
  // on whether a retarget happened to occur later.
  //
  // Here it is true by construction: if agents are being MOVED onto it, the pool statement about it
  // is stale, and the card says so immediately. `relocating` is what keeps that premise honest — a
  // re-pin in place moves nothing, so it revises nothing.
  if (relocating) setAccountInRotation(accountId, true);
}

/** Clear an agent's pin (revert it to auto-pick). Called when an agent is closed, so persisted
 *  pins don't accumulate for agents that no longer exist. */
export function clearPin(agentId: string): void {
  const m = readPins();
  if (!m.delete(agentId)) return; // nothing pinned → don't rewrite storage
  writePins(m);
}

/** Drop all pins (e.g. on full reset). Exposed mainly for tests/teardown. Clears the provenance
 *  marks with them — a mark for a pin that no longer exists would make the next sweep's report of
 *  what it dropped a fiction, and would leak between tests. */
export function clearAllPins(): void {
  writePins(new Map());
  writeSwitchWritten(new Set());
}

/** localStorage key holding the ids whose pin was written by an automated switch rather than by a
 *  person. Exported for tests. */
export const SWITCH_WRITTEN_PINS_STORAGE_KEY = "sparkle.accountPins.switchWritten.v1";

function readSwitchWritten(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(SWITCH_WRITTEN_PINS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    // Unreadable provenance means we cannot prove any pin is machinery's — so we sweep NOTHING and
    // the user's pins survive. Failing closed here costs a stale pin; failing open costs the user's
    // explicit choices.
    return new Set();
  }
}

function writeSwitchWritten(ids: Set<string>): void {
  try {
    globalThis.localStorage?.setItem(SWITCH_WRITTEN_PINS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Same degradation as `writePins`: never break a spawn over provenance bookkeeping.
  }
}

function unmarkSwitchWritten(agentId: string): void {
  const marked = readSwitchWritten();
  if (!marked.delete(agentId)) return; // not marked → don't rewrite storage
  writeSwitchWritten(marked);
}

/** Does this agent carry a pin a PERSON set, as opposed to one a migration wrote (or none)?
 *
 *  The read side of the same provenance mark {@link clearSwitchWrittenPins} uses, and it answers a
 *  question the sweep alone cannot: a fleet activation must not MOVE a hand-pinned agent either.
 *  `chooseAccountForAgent` ranks a pin above the preference precisely because a human chose it, so
 *  migrating one would overwrite that choice with the fleet's — and re-spawn an agent the
 *  `AgentPane` picker deliberately leaves running ("we don't restart a running agent out from under
 *  the user"). Sweeping it later is no remedy: by then the pin already points at the new account. */
export function hasHumanPin(agentId: string): boolean {
  if (getPin(agentId) == null) return false;
  return !readSwitchWritten().has(agentId);
}

/** Drop every pin an automated switch wrote, leaving human pins untouched. Returns the ids dropped.
 *
 *  WHY "Activate this account" needs this: a pin outranks the fleet preference, the switch machinery
 *  writes one for every agent it moves (`moveAgent` → `setPinFromSwitch`), and only agent CLOSE
 *  clears one — a pane unmount is not a close. Without the sweep an activation defeats a LATER
 *  activation: activate A while an agent is mounted (pinning it to A), unmount its pane, activate B,
 *  and that agent is no longer in `paneAccountMap` to be re-pinned, so it keeps spawning on A
 *  forever against an explicit fleet-wide choice that says B.
 *
 *  WHY IT IS KEYED ON PROVENANCE rather than on "everything but the sticky consumers", which was the
 *  first cut: `AgentPane` exposes a per-agent account picker its own comment calls a "manual
 *  override", and a pin beats every judgement selection makes precisely because a human chose it.
 *  The broader sweep therefore deleted every manual override in every project and window on one
 *  click — including for a mounted pane the plan does not even move, whose badge would then keep
 *  rendering a pin that no longer existed.
 *
 *  The sticky consumers need no special case here, and the reason is a property of the WRITERS, not
 *  a happy accident: the only thing that pins those keys is the modal's own per-consumer control,
 *  i.e. a person. `moveAgent` deliberately re-spawns a sticky consumer WITHOUT pinning it, so no
 *  machinery-marked pin on those keys exists for this to find. If that ever changes, this claim
 *  stops being true and they need an explicit exemption. */
export function clearSwitchWrittenPins(): string[] {
  const marked = readSwitchWritten();
  if (marked.size === 0) return [];
  const m = readPins();
  // A loop rather than `[...marked].filter((id) => m.delete(id))` for the same reason as
  // `migratableAgents`: an arrow inside `.filter()` is a line a mutation check can only break
  // syntactically, so the sweep itself would be unprovable in place.
  const dropped: string[] = [];
  for (const id of marked) {
    if (m.delete(id)) dropped.push(id);
  }
  writePins(m);
  writeSwitchWritten(new Set());
  return dropped;
}

// ── The PREFERRED account (fleet-wide) ────────────────────────────────────────────────────────
//
// A DIFFERENT CONCEPT FROM A PIN, and the difference is the whole reason this exists.
//
//   • A pin is PER AGENT and beats every judgement — `pickAccount` honours it even for an account
//     that is exhausted, near its cap, or never signed into, because a human named that one agent
//     and that one account on purpose.
//   • The preferred account is FLEET-WIDE and governs FUTURE spawns. The founder's ask was "I
//     wanna be able to specify an account that I want to make the primary. For agents." — one
//     choice, applied to everything that spawns from now on, not N pins written at the moment the
//     modal happened to be open (which is all the switch banner could ever do: `planSwitch` sees
//     only MOUNTED panes).
//
// Because it is fleet-wide it deliberately does NOT inherit the pin's override power. A pin
// stranding ONE agent at a login prompt is a mistake; the same rule applied to the whole fleet is
// an outage. `accountSelection.chooseAccountForAgent` therefore honours this only while the account
// is real, signed in and not exhausted, and falls through to auto-pick otherwise.
//
// Same read-through-localStorage discipline as the pin map above, for the same reasons: consumed
// outside React, must survive a restart (a preference that evaporates is not a preference), and
// must never let another window's write be masked by a cached copy.

/** localStorage key holding the fleet-wide preferred account id. Exported for tests. */
export const PREFERRED_ACCOUNT_STORAGE_KEY = "sparkle.preferredAccount.v1";

/** The account the user chose to run agents on, or undefined when nothing is chosen (auto-pick).
 *
 *  Returns undefined — never `""` — for a blank or non-string stored value, so a corrupt entry
 *  reads as "no preference" rather than as a preference for an account id that cannot exist. */
export function getPreferredAccountId(): string | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(PREFERRED_ACCOUNT_STORAGE_KEY);
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  } catch {
    return undefined; // storage unavailable → no preference, everything auto-picks
  }
}

/** Make `accountId` the account future spawns prefer. */
export function setPreferredAccountId(accountId: string): void {
  try {
    globalThis.localStorage?.setItem(PREFERRED_ACCOUNT_STORAGE_KEY, accountId);
  } catch {
    // Storage unavailable or over quota. Never let recording a preference break a spawn; the
    // fleet simply keeps auto-picking.
  }
}

/** Forget the preferred account (back to auto-pick for everything unpinned). */
export function clearPreferredAccount(): void {
  try {
    globalThis.localStorage?.removeItem(PREFERRED_ACCOUNT_STORAGE_KEY);
  } catch {
    // Same as above.
  }
}

/** Is this account currently rate-limited?
 *
 *  ONE definition, shared with {@link partitionAccounts} — the preferred-account gate needs exactly
 *  this question and re-deriving it there would be a second rule that drifts the first time either
 *  changed (the same drift `partitionAccounts` was extracted to prevent). A missing usage row means
 *  "nothing observed", i.e. NOT exhausted, matching `usageLookup`'s zero row.
 *
 *  Deliberately narrower than eligibility: near-cap and near-learned-ceiling are ESTIMATES, and a
 *  human who explicitly activated an account is allowed to keep using it while it is merely busy.
 *  `exhaustedUntil` is an OBSERVED limit, which is the one fact worth overriding a human choice for
 *  — spawning there would just fail. */
export function isAccountExhausted(
  usage: readonly Usage[],
  accountId: string,
  now: number = Date.now(),
): boolean {
  return usageExhausted(
    usage.find((x) => x.id === accountId),
    now,
  );
}

/** Is this account at or above Anthropic's OWN proactive-avoidance utilization
 *  ({@link LIVE_AVOID_PERCENT})? Judged PER LOGIN when `siblingIds` is supplied (max real
 *  utilization across the login group), so a duplicate of a spent login whose own live fetch failed
 *  is still counted spent via its twin — the same per-login judgement `exhaustionOutlook` /
 *  `switchRecommendation` use.
 *
 *  THE ONE definition of "live-spent", shared by {@link partitionAccounts} (auto-pick) and the
 *  override-path usability gates in `accountSelection` (transcript affinity). Extracted so the
 *  spawn's proactive-avoid rule cannot mean one thing for a fresh auto-pick and another for a
 *  transcript-holder it decides to resume under — the exact kind of "two definitions, drifted"
 *  split that {@link partitionAccounts}/{@link isAccountExhausted} were factored apart to prevent.
 *
 *  FACT, never estimate — this is Anthropic's own number, distinct from the RETIRED learned-ceiling
 *  gate. And a missing live row (background cache cold, offline, 401, keychain declined) is NOT an
 *  exclusion: {@link loginLiveWorstPercent} returns null there and null reads as "not spent", so an
 *  unreadable figure never looks like a full one — exactly as it must never look like an empty one.
 *
 *  Deliberately NOT applied to `usablePreferredAccount`: a human who explicitly activated an account
 *  is entitled to keep using it while it is busy; transcript affinity is an AUTOMATIC continuity
 *  preference with no human choice to respect, so it is aligned with auto-pick instead. */
export function isAccountLiveSpent(
  accountId: string,
  live: readonly LiveUsage[] | undefined,
  siblingIds?: ReadonlyMap<string, readonly string[]>,
): boolean {
  const liveById = new Map((live ?? []).map((l) => [l.id, l]));
  const p = loginLiveWorstPercent(accountId, liveById, siblingIds);
  return p != null && p >= LIVE_AVOID_PERCENT;
}

/** What a just-completed login into a fresh config dir turned out to be.
 *
 *  The founder's question was "do I need to type the email in manually?" — the answer is no, and
 *  this is where that answer is computed. Claude Code writes `oauthAccount.emailAddress` into the
 *  config dir it was pointed at, Rust surfaces it as {@link Identity.email}, so the nickname can be
 *  derived rather than typed. */
export type AdoptionOutcome =
  /** A new, distinct login. `nickname` is the email to name it by. */
  | { kind: "named"; nickname: string }
  /** This login is ALREADY registered under another account row. */
  | { kind: "duplicate"; existingNickname: string }
  /** No readable identity behind the dir — the login did not complete, or was cancelled. */
  | { kind: "unidentified" };

/** Decide what to do with `accountId` once its login flow reported success. PURE — no IO.
 *
 *  Refusing a duplicate is not tidiness, it is the core invariant of the whole multi-account
 *  feature. Two rows sharing ONE Anthropic login re-create the exact failure this exists to end:
 *  their quota is shared but their tallies are not, so each looks half-used, both win auto-pick,
 *  and the learned ceiling is computed from a fraction of the real consumption. `identityKey`
 *  decides sameness by `accountUuid` (falling back to a verified email) — never by nickname, which
 *  is user-typed and proves nothing.
 *
 *  An UNIDENTIFIED result is deliberately not treated as "new". A dir with no `oauthAccount` is a
 *  login that did not finish; naming it from a guess would register an account that cannot run. */
export function adoptionOutcome(
  accountId: string,
  accounts: readonly Account[],
  identities: readonly Identity[],
): AdoptionOutcome {
  const mine = identities.find((i) => i.id === accountId);
  const key = identityKey(mine);
  if (key == null) return { kind: "unidentified" };

  for (const other of identities) {
    if (other.id === accountId) continue;
    // Same LOGIN and same ORGANIZATION — {@link accountsAreSame}, not a raw `identityKey` equality.
    // A Team org and a Personal Max under one email share an `accountUuid` (so their keys match) but
    // are DIFFERENT Anthropic accounts; refusing the second as a "duplicate" is the exact bug the
    // founder hit. Org can only split a shared login, so a genuine two-dir duplicate is still caught.
    if (!accountsAreSame(mine, other)) continue;
    const row = accounts.find((a) => a.id === other.id);
    return { kind: "duplicate", existingNickname: row?.nickname ?? other.email ?? "another account" };
  }

  // Prefer the email; a login can carry a uuid with no readable email (see `accountSentenceName`),
  // and naming that row after a raw uuid would be worse than leaving the placeholder alone.
  return mine?.email ? { kind: "named", nickname: mine.email } : { kind: "unidentified" };
}
