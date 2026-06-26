// Spawn-path glue for multi Claude Max account support (design spec
// docs/superpowers/specs/2026-06-26-multi-max-account-design.md). Each agent spawn must pick the
// account it runs under (lowest-usage, honoring a manual pin) and pass that account's config dir as
// CLAUDE_CONFIG_DIR. AgentPane calls chooseAccountForAgent() right before building the exec.
//
// The accounts + usage come from Rust over IPC; a burst of agent panes mounting at once would each
// fire those two calls. So we cache the (accounts, usage) pair for a few seconds and de-dupe
// concurrent loads — "cache reasonably" per the task. The cache is invalidated whenever the set
// changes (add/remove/login) so badges and selection see fresh data promptly.
import { listAccounts, getUsage, pickAccount, getPin, type Account, type Usage } from "./accountStore";

export interface AccountState {
  accounts: Account[];
  usage: Usage[];
}

const EMPTY: AccountState = { accounts: [], usage: [] };

/** How long a loaded (accounts, usage) snapshot is reused before re-fetching. Short: usage drifts
 *  as agents run, but a few seconds collapses a mount storm into one IPC pair. */
export const ACCOUNT_CACHE_TTL_MS = 5_000;

let cache: { at: number; state: AccountState } | null = null;
let inflight: Promise<AccountState> | null = null;
// Bumped on every invalidate. A load captures the generation before its await and only writes to
// the cache if it still matches on resolve — so an invalidate that fires mid-load (e.g. the user
// adds/renames an account while an AgentPane is preparing a spawn) can't be clobbered by the
// in-flight fetch repopulating the cache with the now-stale snapshot.
let generation = 0;

/** Load accounts + usage, served from a short TTL cache and de-duped across concurrent callers.
 *  Best-effort: on IPC failure it resolves to empty arrays (→ no accounts → default spawn behavior,
 *  so a backend hiccup never blocks an agent from starting). `force` bypasses the cache. */
export async function loadAccountState(opts: { force?: boolean; now?: number } = {}): Promise<AccountState> {
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    if (cache && now - cache.at < ACCOUNT_CACHE_TTL_MS) return cache.state;
    if (inflight) return inflight;
  }
  const gen = generation;
  const p = (async () => {
    try {
      const [accounts, usage] = await Promise.all([listAccounts(), getUsage()]);
      const state: AccountState = { accounts, usage };
      if (gen === generation) cache = { at: now, state }; // skip if invalidated mid-load
      return state;
    } catch {
      if (gen === generation) cache = null; // don't pin a failure; the next call retries
      return EMPTY;
    } finally {
      if (gen === generation) inflight = null; // don't clear a newer load's inflight
    }
  })();
  inflight = p;
  return p;
}

/** Drop the cache so the next load re-fetches (call after add/remove/login or a failover update).
 *  Bumps the generation so any in-flight load won't repopulate the cache with its stale snapshot. */
export function invalidateAccountState(): void {
  cache = null;
  inflight = null;
  generation++;
}

/** Choose the account `agentId` should spawn under (honoring its manual pin) plus the loaded state
 *  (for the pane's account badge/dropdown). `chosen` is null only when no accounts exist — then the
 *  spawn omits CLAUDE_CONFIG_DIR and behaves exactly as before accounts existed. */
export async function chooseAccountForAgent(
  agentId: string,
  opts: { force?: boolean; now?: number } = {},
): Promise<{ chosen: Account | null; state: AccountState }> {
  const state = await loadAccountState(opts);
  const chosen = pickAccount(state.accounts, state.usage, {
    pinnedAccountId: getPin(agentId),
    now: opts.now,
  });
  return { chosen, state };
}
