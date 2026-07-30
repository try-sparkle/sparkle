// Spawn-path glue for multi Claude Max account support (design spec
// docs/superpowers/specs/2026-06-26-multi-max-account-design.md). Each agent spawn must pick the
// account it runs under (lowest-usage, honoring a manual pin) and pass that account's config dir as
// CLAUDE_CONFIG_DIR. AgentPane calls chooseAccountForAgent() right before building the exec.
//
// The accounts + usage come from Rust over IPC; a burst of agent panes mounting at once would each
// fire those two calls. So we cache the (accounts, usage) pair for a few seconds and de-dupe
// concurrent loads — "cache reasonably" per the task. The cache is invalidated whenever the set
// changes (add/remove/login) so badges and selection see fresh data promptly.
import {
  listAccounts,
  getUsage,
  getIdentities,
  pickAccount,
  eligibleAccounts,
  getPin,
  signedInAccountIds,
  type Account,
  type Usage,
  type Identity,
} from "./accountStore";

export interface AccountState {
  accounts: Account[];
  usage: Usage[];
  /** Real authenticated identity (email + org) per account id — the trustworthy badge label. */
  identities: Identity[];
  /** The load did not succeed, so the empty arrays above mean "unknown", NOT "no accounts".
   *
   *  Both cases degrade to the same spawn (no `CLAUDE_CONFIG_DIR`), which is why nothing needed to
   *  tell them apart before. A caller that ACTS on a change of account does: reading a transient
   *  IPC failure as "moved to the default account" made the concierge discard a live conversation
   *  it should have kept. Optional so every existing reader is unaffected. */
  failed?: boolean;
}

const EMPTY: AccountState = { accounts: [], usage: [], identities: [], failed: true };

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
      const [accounts, usage, identities] = await Promise.all([
        listAccounts(),
        getUsage(),
        getIdentities(),
      ]);
      // Shape-checked, not just error-checked. The `catch` below only covers a REJECTED invoke; a
      // bridge that resolves something that isn't an array (an older/absent command, a non-Tauri
      // host) would sail past it and throw a TypeError inside `pickAccount` instead — outside this
      // guard, on the spawn path. Coercing to [] means a malformed reply reads as "no accounts
      // configured", which is exactly the degradation the rejection path already chose.
      const shapeOk =
        Array.isArray(accounts) && Array.isArray(usage) && Array.isArray(identities);
      const state: AccountState = {
        accounts: Array.isArray(accounts) ? accounts : [],
        usage: Array.isArray(usage) ? usage : [],
        identities: Array.isArray(identities) ? identities : [],
        // A malformed reply is a FAILURE, not an empty account list — same as a rejection below.
        // Without this the coercion above would quietly launder "the bridge is broken" into "you
        // have no accounts", which is precisely the confusion `failed` exists to end.
        failed: !shapeOk,
      };
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
 *  spawn omits CLAUDE_CONFIG_DIR and behaves exactly as before accounts existed.
 *
 *  The loaded identities gate auto-pick: only accounts actually `claude login`ed are candidates, so
 *  a config dir that exists but was never signed into can't win on its (necessarily zero) usage and
 *  strand the agent at a login prompt — sparkle-gms0.
 *
 *  THE ONLY RESOLVER. Everything that needs "which account does X run under" comes through here —
 *  the pane, the concierge, the hourly pass — because the alternative was measured and it is a bug
 *  factory: Improve Sparkle is reachable by BOTH the pane (an `AgentPane` whose `agent.id` IS
 *  `SPARKLE_AGENT_ID`) and the headless pass, and a stickiness rule applied to only one of them let
 *  the two spawn under different accounts into ONE shared worktree. Whatever the rule is, it has to
 *  be applied in a single place or the paths drift. */
export async function chooseAccountForAgent(
  agentId: string,
  opts: { force?: boolean; now?: number } = {},
): Promise<{ chosen: Account | null; state: AccountState }> {
  const state = await loadAccountState(opts);
  // Built ONCE and shared by both branches. Splitting them is how the pinned path silently lost
  // `signedInIds` and re-opened sparkle-gms0: `pickAccount` honours a pin only if it names an
  // EXISTING account, so a pin left behind by a deleted account falls through to auto-pick — and
  // without the signed-in filter a never-logged-in config dir wins on its zero usage and strands
  // the job at a login prompt.
  const base = { signedInIds: signedInAccountIds(state.identities), now: opts.now };
  const pinnedAccountId = getPin(agentId);
  const chosen = pinnedAccountId
    ? pickAccount(state.accounts, state.usage, { ...base, pinnedAccountId })
    : autoPick(agentId, state, base);
  return { chosen, state };
}

/** Auto-pick for `agentId` — sticky for the keys that need it, plain `pickAccount` otherwise. */
function autoPick(
  agentId: string,
  state: AccountState,
  base: { signedInIds: string[]; now?: number },
): Account | null {
  if (!isStickyAccountKey(agentId)) return pickAccount(state.accounts, state.usage, base);
  const previousId = stickySelections.get(agentId);
  if (previousId) {
    const stillHealthy = eligibleAccounts(state.accounts, state.usage, base).find(
      (a) => a.id === previousId,
    );
    if (stillHealthy) return stillHealthy;
  }
  const chosen = pickAccount(state.accounts, state.usage, base);
  if (chosen) stickySelections.set(agentId, chosen.id);
  return chosen;
}

// ── Consumers that have no agent pane ────────────────────────────────────────────────────────
//
// Sparkle runs `claude` from THREE places, not one: build-agent panes, the hourly Improve Sparkle
// pass, and the concierge. Only the first went through the selection above; the other two set no
// `CLAUDE_CONFIG_DIR` at all and so were pinned to `$HOME/.claude` — the `isDefault` account —
// permanently. That is why signing into a different account moved the build agents and nothing
// else, and why the human experienced one login per consumer
// (PRD/sparkle/account-rotation.md §2).
//
// They join the EXISTING mechanism rather than getting one of their own: each addresses
// `chooseAccountForAgent` under a stable key, so `pickAccount` — lowest-usage, skips exhausted,
// signed-in only, manual pin wins — decides for all three by the same rule.
//
// WITH ONE ADDED PROPERTY, applied per KEY rather than per call site: STICKINESS. See
// `isStickyAccountKey`.
//
// (No UI writes a pin for the concierge key today. `setPin`'s only production callers are
// `AgentPane` — keyed by an agent id, so it needs a pane — and `accountSwitch`. The key IS
// pin-capable, and a pin placed on it is honoured, but nothing a human can click places one yet;
// giving the concierge a visible account control belongs with the rest of the Phase 2 account UI.
// Stickiness is what makes that absence tolerable rather than a hole.)

/** Account key for the CONCIERGE.
 *
 *  Deliberately the same literal as `CONCIERGE_CALLER_AGENT_ID` in `controlListener.ts` (and
 *  `bridge.rs`) — that is already this component's stable identity everywhere else, so reusing it
 *  keeps one name for one thing. Re-declared here rather than imported because `controlListener`
 *  pulls in the whole concierge tool registry; a production import from this leaf module would be a
 *  cycle. `accountSelection.test.ts` asserts the two literals stay equal. */
export const CONCIERGE_ACCOUNT_KEY = "sparkle:concierge";

/** The app-owned Improve Sparkle namespace (`sparkleAgent.ts`'s `SPARKLE_AGENT_ID`, plus its
 *  per-window `-win-<uuid>` variants). Re-declared for the same no-cycle reason as the concierge key
 *  above; `accountSelection.test.ts` pins it against `isSparkleAgentId`. */
const SPARKLE_SELF_ACCOUNT_PREFIX = "__sparkle_self__";

/** Does this key get a STICKY account — one that persists until it stops being a healthy choice —
 *  rather than a fresh auto-pick each time?
 *
 *  A PROPERTY OF THE KEY, NOT OF THE CALLER, and that is the whole point. A build agent resolves its
 *  account once, at spawn, so re-picking costs it nothing. These two resolve REPEATEDLY against a
 *  usage tally that drifts continuously as build agents burn tokens:
 *
 *  - the concierge, once per turn — a flip strands its session id in the previous account's
 *    transcript tree, so `--resume` fails, the send path burns a second `claude` on its self-heal,
 *    and a proactive push (which has no retry, by design) is silently dropped;
 *  - Improve Sparkle, once per hourly pass AND again whenever its interactive pane opens.
 *
 *  Improve Sparkle is why this is keyed rather than call-sited. Its pane is an ordinary `AgentPane`
 *  whose `agent.id` IS `SPARKLE_AGENT_ID`, so it resolves through `chooseAccountForAgent` like any
 *  agent, while the headless pass resolves through `accountConfigDirFor`. Making only the latter
 *  sticky let the two land on DIFFERENT accounts for ONE SHARED WORKTREE — the pane's resume probe
 *  would then look in the wrong tree, miss the transcript the pass had just written, and restart the
 *  conversation. Keying it means both paths get the same answer no matter which one asks. */
export function isStickyAccountKey(key: string): boolean {
  return (
    key === CONCIERGE_ACCOUNT_KEY ||
    key === SPARKLE_SELF_ACCOUNT_PREFIX ||
    key.startsWith(`${SPARKLE_SELF_ACCOUNT_PREFIX}-`)
  );
}

/** The account each sticky key settled on, so a later call reuses it instead of re-picking.
 *  Process-lifetime only: a restart re-picks, which is correct — usage has moved on and there is no
 *  live conversation to keep continuity with. */
const stickySelections = new Map<string, string>();

/** Forget the sticky selections (tests, and any future "re-evaluate now" trigger). */
export function resetStickyAccounts(): void {
  stickySelections.clear();
}

/** Failure is DISTINCT from "the default account", and conflating them cost the concierge its
 *  conversation. `null` is a real answer — no accounts configured, or the default account, whose
 *  `configDir` is the empty string precisely to mean "export no override" (accounts.rs). `undefined`
 *  means the question could not be answered at all: the accounts backend rejected, replied with
 *  something that isn't an array, or threw.
 *
 *  Both spawn `claude` identically (neither sets the variable). The difference matters to callers
 *  that ACT on a change of account: a transient IPC hiccup read as "moved to the default account"
 *  made `concierge.ts` discard the live conversation pointer AND its on-disk fallback — the exact
 *  loss the error path is written to prevent — and then flip back on the next successful resolve. */
export type ResolvedConfigDir = string | null | undefined;

/** The `CLAUDE_CONFIG_DIR` a consumer should spawn its `claude` child under. See
 *  {@link ResolvedConfigDir} for what `null` vs `undefined` mean.
 *
 *  A thin wrapper over {@link chooseAccountForAgent} — deliberately, so it cannot develop a second
 *  selection rule. Stickiness, the pin, and the signed-in filter all live there and therefore apply
 *  identically whether an account is resolved for a pane, for the concierge, or for the hourly pass.
 *
 *  NEVER REJECTS, and that is load-bearing rather than defensive habit. Both callers await this on
 *  the path that starts the work — a concierge turn, an hourly pass — so a throw here would not
 *  degrade the account choice, it would kill the turn outright. */
export async function accountConfigDirFor(
  key: string,
  opts: { force?: boolean; now?: number } = {},
): Promise<ResolvedConfigDir> {
  try {
    const { chosen, state } = await chooseAccountForAgent(key, opts);
    // `failed` is the ONLY way to tell "the backend is broken" from "there are no accounts": both
    // arrive here as an empty list, and `loadAccountState` degrades to empty on purpose so a hiccup
    // never blocks a spawn.
    if (state.failed) return undefined;
    return chosen?.configDir || null;
  } catch (e) {
    console.warn("accountSelection: could not resolve an account; inheriting the default:", e);
    return undefined;
  }
}
