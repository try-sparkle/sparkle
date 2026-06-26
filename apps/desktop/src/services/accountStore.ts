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

/** Sparkle metadata for one registered Claude config dir. `configDir` is the absolute path we set
 *  as CLAUDE_CONFIG_DIR when spawning under this account. `isDefault` marks the imported `~/.claude`
 *  (cannot be removed). `createdAt` is epoch ms. */
export interface Account {
  id: string;
  nickname: string;
  configDir: string;
  isDefault: boolean;
  createdAt: number;
}

/** Per-account token tally (camelCase boundary type used by the whole app). `tokens5h` / `tokens7d`
 *  are the windowed token tallies read from that account's own transcripts. `exhaustedUntil` is the
 *  epoch-ms instant a real rate-limit is expected to reset (null = not exhausted). */
export interface Usage {
  id: string;
  tokens5h: number;
  tokens7d: number;
  exhaustedUntil: number | null;
}

/** Raw shape the Rust side returns (snake_case) — mapped to {@link Usage} at the boundary. */
interface RawUsage {
  id: string;
  tokens_5h: number;
  tokens_7d: number;
  exhausted_until: number | null;
}

function mapUsage(raw: RawUsage): Usage {
  return {
    id: raw.id,
    tokens5h: raw.tokens_5h,
    tokens7d: raw.tokens_7d,
    exhaustedUntil: raw.exhausted_until ?? null,
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

/** Flag an account as rate-limited until `untilEpoch` (epoch ms). Selection excludes it until then. */
export function markExhausted(id: string, untilEpoch: number): Promise<void> {
  return invoke("accounts_mark_exhausted", { id, untilEpoch });
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

export const DEFAULT_NEAR_CAP: NearCap = {
  tokens5h: 5_000_000,
  tokens7d: 30_000_000,
};

export interface PickOptions {
  /** Manual per-agent override. If set and it names an existing account, that account wins
   *  unconditionally (even if exhausted/near-cap) — a human chose it on purpose. */
  pinnedAccountId?: string;
  /** Soft window ceilings; defaults to {@link DEFAULT_NEAR_CAP}. */
  nearCap?: NearCap;
  /** Current time (epoch ms), injectable for tests. Defaults to `Date.now()`. */
  now?: number;
}

/** Choose the account a new job should run under. PURE — no IO.
 *
 *  Order (design spec §"Per-job account selection"):
 *    1. A valid `pinnedAccountId` override wins outright.
 *    2. Otherwise drop accounts that are exhausted (`exhaustedUntil` in the future) or near a
 *       window cap, then pick the LOWEST `tokens7d` (tie-break: lowest `tokens5h`).
 *    3. If that leaves nothing, fall back to the default account (else the first account) — we
 *       never return null while any account exists; the hard rate-limit is the real backstop.
 *  Returns null only for an empty account list. Accounts with no usage row are treated as having
 *  the most headroom (zero tokens, not exhausted). */
export function pickAccount(
  accounts: Account[],
  usage: Usage[],
  opts: PickOptions = {},
): Account | null {
  if (accounts.length === 0) return null;

  const { pinnedAccountId, nearCap = DEFAULT_NEAR_CAP, now = Date.now() } = opts;

  if (pinnedAccountId) {
    const pinned = accounts.find((a) => a.id === pinnedAccountId);
    if (pinned) return pinned;
  }

  const usageById = new Map(usage.map((u) => [u.id, u]));
  const ZERO: Usage = { id: "", tokens5h: 0, tokens7d: 0, exhaustedUntil: null };
  const usageFor = (a: Account): Usage => usageById.get(a.id) ?? ZERO;

  const isExhausted = (u: Usage) => u.exhaustedUntil != null && u.exhaustedUntil > now;
  const isNearCap = (u: Usage) => u.tokens5h >= nearCap.tokens5h || u.tokens7d >= nearCap.tokens7d;

  const candidates = accounts.filter((a) => {
    const u = usageFor(a);
    return !isExhausted(u) && !isNearCap(u);
  });

  if (candidates.length === 0) {
    // Everyone is exhausted / near-cap: fall back rather than block. Prefer the default account.
    // accounts is non-empty (guarded above), so accounts[0] is defined.
    return accounts.find((a) => a.isDefault) ?? (accounts[0] as Account);
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

// ── In-memory pin map (agentId → accountId) ───────────────────────────────────────────────────
// A manual per-agent override the integrator (Worker C) reads before each spawn and passes to
// `pickAccount({ pinnedAccountId })`. Phase 1 keeps this in memory only (resets on app restart);
// persisting it is explicitly out of scope per the task.
const pinMap = new Map<string, string>();

/** The account this agent is pinned to, or undefined if it auto-picks. */
export function getPin(agentId: string): string | undefined {
  return pinMap.get(agentId);
}

/** Pin `agentId` to `accountId` (manual override for all of this agent's future spawns). */
export function setPin(agentId: string, accountId: string): void {
  pinMap.set(agentId, accountId);
}

/** Clear an agent's pin (revert it to auto-pick). */
export function clearPin(agentId: string): void {
  pinMap.delete(agentId);
}

/** Drop all pins (e.g. on full reset). Exposed mainly for tests/teardown. */
export function clearAllPins(): void {
  pinMap.clear();
}
