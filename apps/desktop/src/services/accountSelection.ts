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
  listCeilings,
  pickAccount,
  eligibleAccounts,
  getPin,
  signedInAccountIds,
  type Account,
  type Usage,
  type Identity,
  type PickOptions,
} from "./accountStore";
import type { Ceiling } from "./headroom";

export interface AccountState {
  accounts: Account[];
  usage: Usage[];
  /** Real authenticated identity (email + org) per account id — the trustworthy badge label. */
  identities: Identity[];
  /** Per-account LEARNED rate-limit ceilings. Feeds the PROACTIVE half of selection: an account at
   *  or above `CEILING_AVOID_FRACTION` of its own ceiling stops receiving new spawns, so rotation
   *  happens before the wall instead of after it. Empty means "nothing learned yet", which degrades
   *  selection to the previous lowest-usage rule rather than to a guess. */
  ceilings: Ceiling[];
  /** The load did not succeed, so the empty arrays above mean "unknown", NOT "no accounts".
   *
   *  Both cases degrade to the same spawn (no `CLAUDE_CONFIG_DIR`), which is why nothing needed to
   *  tell them apart before. A caller that ACTS on a change of account does: reading a transient
   *  IPC failure as "moved to the default account" made the concierge discard a live conversation
   *  it should have kept. Optional so every existing reader is unaffected. */
  failed?: boolean;
}

const EMPTY: AccountState = { accounts: [], usage: [], identities: [], ceilings: [], failed: true };

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
 *  so a backend hiccup never blocks an agent from starting). `force` bypasses the cache.
 *
 *  `withIdentities: false` SKIPS the `getIdentities()` leg, and exists because that leg is by far
 *  the most expensive one: `accounts_identities` reads and JSON-parses EVERY registered account's
 *  whole `.claude.json` — hundreds of KB for the imported `~/.claude`, which grows with project
 *  history — to pull three fields out of `oauthAccount`, and folds the result into the
 *  identity-epoch ledger. That is the right price for the spawn path, which gates auto-pick on
 *  identities. It is the wrong price for a POLLER that never reads the field: the usage-limit
 *  banner re-reads on `USAGE_LIMIT_RECHECK_MS` (10s) while the cache TTL above is 5s, so no tick
 *  can ever be served from cache and the full parse was being paid six times a minute, per mounted
 *  banner, for as long as a limit was showing — hours, by that feature's own premise (`sparkle-608gg`).
 *
 *  An identity-less load is PRIVATE to its caller: it neither writes the shared cache nor publishes
 *  itself as the in-flight load, because `identities: []` is indistinguishable from "nobody is
 *  signed in" and auto-pick would read it that way. */
export async function loadAccountState(
  opts: { force?: boolean; now?: number; withIdentities?: boolean } = {},
): Promise<AccountState> {
  const now = opts.now ?? Date.now();
  // `withIdentities: false` drops the getIdentities() leg — see the doc-comment above for why the
  // banner needs it. Default true so every existing caller is untouched.
  const withIdentities = opts.withIdentities !== false;
  if (!opts.force) {
    if (cache && now - cache.at < ACCOUNT_CACHE_TTL_MS) return cache.state;
    if (inflight) return inflight;
  }
  const gen = generation;
  const p = (async () => {
    try {
      const [accounts, usage, identities, ceilings] = await Promise.all([
        listAccounts(),
        getUsage(),
        withIdentities ? getIdentities() : Promise.resolve([] as Identity[]),
        // SWALLOWED SEPARATELY, and that asymmetry is deliberate. The other three are load-bearing:
        // if they fail, the load genuinely failed. Ceilings only ever REFINE the pick — with none,
        // selection is exactly the lowest-usage rule that shipped before. So a backend that predates
        // `accounts_ceilings` (or one that rejects it) must degrade to "nothing learned yet", NOT to
        // `failed: true`, which is a signal `concierge.ts` acts on by discarding its live
        // conversation pointer. Letting an optional refinement trigger that path would trade a
        // slightly worse account choice for a lost conversation.
        listCeilings().catch(() => [] as Ceiling[]),
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
        // Not part of `shapeOk` for the same reason it has its own catch: a malformed ceilings reply
        // costs us a refinement, not the load.
        ceilings: Array.isArray(ceilings) ? ceilings : [],
        // A malformed reply is a FAILURE, not an empty account list — same as a rejection below.
        // Without this the coercion above would quietly launder "the bridge is broken" into "you
        // have no accounts", which is precisely the confusion `failed` exists to end.
        failed: !shapeOk,
      };
      // NEVER publish an identity-less snapshot. `identities: []` is indistinguishable from "nobody
      // is signed in", and auto-pick GATES on it (see chooseAccountForAgent) — caching this would
      // strand every spawn at a login prompt. A `withIdentities: false` reader is opting out for
      // itself, not for the app.
      if (withIdentities && gen === generation) cache = { at: now, state }; // skip if invalidated mid-load
      return state;
    } catch {
      if (gen === generation) cache = null; // don't pin a failure; the next call retries
      return EMPTY;
    } finally {
      // `withIdentities` guard as well as the generation one: an identity-less load never PUBLISHED
      // itself as `inflight`, so clearing it here would cancel a full load someone else is awaiting.
      if (withIdentities && gen === generation) inflight = null; // don't clear a newer load's inflight
    }
  })();
  // Same reason as the cache write: an identity-less load must not be handed to a concurrent caller
  // that asked for the full state. It stays private to its requester.
  if (withIdentities) inflight = p;
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
  // RIDE OUT A HICCUP, HERE, so both callers of a key get the same answer.
  //
  // When the accounts backend cannot be read, every account looks absent, so a fresh pick would put
  // the job on the DEFAULT account — a different transcript tree. That is not a neutral degradation:
  // Improve Sparkle is reached by two callers on one key (the hourly pass and its pane) sharing ONE
  // worktree, so one of them relocating means the other looks for a transcript that was never
  // written there. The rule lived in the pass for exactly one commit, which left the pane on a
  // second rule — the drift this function's header warns about, in the function itself.
  //
  // Nothing is remembered until something resolved, so a first-ever call with a broken backend still
  // reports "unknown" (no accounts → `chosen: null`) rather than inventing one.
  const remembered = state.failed ? lastResolvedAccount.get(agentId) : undefined;
  if (remembered) return { chosen: remembered, state };
  // Built ONCE and shared by both branches. Splitting them is how the pinned path silently lost
  // `signedInIds` and re-opened sparkle-gms0: `pickAccount` honours a pin only if it names an
  // EXISTING account, so a pin left behind by a deleted account falls through to auto-pick — and
  // without the signed-in filter a never-logged-in config dir wins on its zero usage and strands
  // the job at a login prompt.
  // `ceilings` rides in the SHARED base for the same reason `signedInIds` does: both the pinned and
  // the auto-pick branch read it, and the one time these were built separately the pinned path
  // silently lost `signedInIds` and re-opened sparkle-gms0. A pin still overrides everything —
  // `pickAccount` honours it even for a near-cap account, because a human chose it on purpose.
  const base = {
    signedInIds: signedInAccountIds(state.identities),
    now: opts.now,
    ceilings: state.ceilings,
  };
  // A pin only counts if it still names a REAL account. Branching on the pin's mere presence let a
  // STALE pin — one left behind by a deleted account — bypass everything below it: `pickAccount`
  // ignores an unmatched `pinnedAccountId` and falls through to plain lowest-usage auto-pick, so a
  // sticky key silently stopped being sticky and recorded nothing. Reachable today, because
  // `setPin` is written for `SPARKLE_AGENT_ID` (its pane is an `AgentPane`) and by `accountSwitch`,
  // while the only `clearPin` caller is the doomed-agent path — nothing prunes a pin when its
  // account is removed. The result was the divergence `isStickyAccountKey` exists to prevent, on
  // the very key it was written for.
  const pin = getPin(agentId);
  const pinnedAccountId = pin && state.accounts.some((a) => a.id === pin) ? pin : undefined;
  const chosen = pinnedAccountId
    ? pickAccount(state.accounts, state.usage, { ...base, pinnedAccountId })
    : autoPick(agentId, state, base);
  // Remember it so the branch above can carry this key through a later hiccup.
  if (chosen) lastResolvedAccount.set(agentId, chosen);
  return { chosen, state };
}

/** Auto-pick for `agentId` — sticky for the keys that need it, plain `pickAccount` otherwise.
 *
 *  `base` is typed as the full `PickOptions` on purpose. It was once narrowed to the two fields this
 *  function reads, which typechecked cleanly while silently dropping `ceilings` for anyone who
 *  rebuilt it from its declared type — the same drift that lost `signedInIds` and re-opened
 *  sparkle-gms0, one level up (roborev 59923). */
function autoPick(agentId: string, state: AccountState, base: PickOptions): Account | null {
  if (!isStickyAccountKey(agentId)) return pickAccount(state.accounts, state.usage, base);
  const previousId = stickySelections.get(agentId);
  if (previousId) {
    // THE LEARNED CEILING DOES NOT GET A VOTE ON KEEPING AN ACCOUNT — only on choosing one.
    //
    // This asymmetry is the whole point, and getting it wrong is a live conversation. The safety
    // argument for acting on an estimate is that a FRESH spawn has nothing to lose. That does not
    // hold here: the concierge resolves this key once per TURN, and a changed answer runs
    // `rebindSessionToAccount`, which nulls both session pointers and re-probes. An ordinary turn
    // self-heals into a fresh session (visible, survivable). A PROACTIVE push does not — it has no
    // stale-resume retry by design, so a resume aimed at the old account's tree just dies silently,
    // and nobody asked for that push, so nobody notices it is missing.
    //
    // So a sticky key moves only on `exhaustedUntil` — an OBSERVED rate limit, which is fact rather
    // than estimate, and which is exactly what moved it before this gate existed. That is strictly
    // no worse than the previous behaviour for these two consumers, while fresh spawns still rotate
    // proactively, which is where the fleet-wide win actually is.
    const keepOpts: PickOptions = { ...base, ceilings: undefined };
    const stillHealthy = eligibleAccounts(state.accounts, state.usage, keepOpts).find(
      (a) => a.id === previousId,
    );
    if (stillHealthy) return stillHealthy;
  }
  // FIRST pick for this key (or its previous account just hit a real limit): the ceilings DO apply.
  // There is no conversation to strand yet, so this is the fresh-spawn case and gets the fresh-spawn
  // rule — a sticky key should not settle onto an account that is already nearly spent.
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

/** The last ACCOUNT each key resolved to, so `chooseAccountForAgent` can carry a key through a
 *  temporarily unreadable accounts backend. The whole record, not just an id: mapping an id back to
 *  its config dir needs the account list we just failed to load, which is precisely the situation
 *  this exists for. Distinct from `stickySelections`, which answers "what did we settle on" for a
 *  HEALTHY load and holds only an id. */
const lastResolvedAccount = new Map<string, Account>();

/** Forget the sticky selections (tests, and any future "re-evaluate now" trigger). */
export function resetStickyAccounts(): void {
  stickySelections.clear();
  lastResolvedAccount.clear();
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
    // `undefined` only when the backend failed AND this key has nothing to fall back on — with a
    // remembered account, `chooseAccountForAgent` has already answered coherently and the caller
    // needs no failure signal.
    if (state.failed && !chosen) return undefined;
    return chosen?.configDir || null;
  } catch (e) {
    console.warn("accountSelection: could not resolve an account; inheriting the default:", e);
    return undefined;
  }
}
