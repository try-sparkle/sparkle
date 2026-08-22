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
  getPreferredAccountId,
  isAccountExhausted,
  markExhausted,
  isAccountLiveSpent,
  signedInAccountIds,
  notSignedInAccountIds,
  signedInFilterApplies,
  loginSiblingIds,
  clobberedDefaultIds,
  type Account,
  type Usage,
  type Identity,
  type PickOptions,
  type LiveUsage,
} from "./accountStore";
import { getAccountUsageLive } from "./accountUsage";
// The user's own steering of the pool: the accounts taken out of rotation from the accounts screen,
// and the fleet-wide pause. Both read through localStorage on every call — see `rotationState.ts` for
// why that discipline, and why neither is allowed to block a spawn.
import { rotationOutIds, rotationPause } from "./rotationState";
import { claudeSessionAccounts } from "../preflight";
import type { Ceiling } from "./headroom";
import type { ConciergeFailureKind } from "../engine/conciergeFailureNotice";
import {
  recordSelection,
  shouldLogSelection,
  type SelectionReason,
  type SpawnLogEntry,
} from "./accountLedger";

export interface AccountState {
  accounts: Account[];
  usage: Usage[];
  /** Real authenticated identity (email + org) per account id — the trustworthy badge label. */
  identities: Identity[];
  /** Per-account LEARNED rate-limit ceilings. NO LONGER GATES SELECTION — the founder retired the
   *  estimate as a driver (it read "90% of its usual limit" while the real Anthropic numbers were
   *  clear). Proactive avoidance is now `PickOptions.live` (real Anthropic utilization); the observed
   *  wall (`exhaustedUntil`) is the reactive backstop. Ceilings are still passed through for the
   *  all-excluded FALLBACK ranking (`accountStore.leastBad`) and for `assessHeadroom`'s reporting
   *  states; empty means "nothing learned yet". */
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

// ── REAL Anthropic utilization, cached OFF the spawn's critical path ────────────────────────────
//
// `pickAccount` needs this to avoid routing at the most exhausted account on the machine (see
// `PickOptions.live`), but fetching it is expensive in a way the local tally is not: it reads an
// OAuth secret — a keychain read that can raise a macOS confidential-info prompt — and then makes a
// network call with a 15s ceiling, PER ACCOUNT. Awaiting that before every spawn would gate each
// agent behind N blocking round-trips and, worse, would make a spawn fail when the network does.
//
// So it is a BACKGROUND cache with a read that never blocks. `liveUsageRows()` returns whatever is
// currently known, and an empty result is a perfectly good answer: `pickAccount` degrades to the
// local-tally rule exactly as it behaved before this existed. The refresh is kicked off by
// `loadAccountState` and never awaited by it.
//
// The TTL is much longer than the account cache's 5s because utilization moves on the scale of a
// window (hours), not a mount storm (milliseconds) — and because each refresh costs N network calls.
export const LIVE_USAGE_TTL_MS = 120_000;

let liveCache: { at: number; rows: LiveUsage[] } | null = null;
let liveInflight: Promise<void> | null = null;

/** The live rows currently known. Never fetches, never blocks, never throws. Empty means "we don't
 *  know yet", which selection treats as "judge these accounts by the local tally" — NOT as zero. */
export function liveUsageRows(): LiveUsage[] {
  return liveCache?.rows ?? [];
}

/** Drop the cache so the next {@link loadAccountState} refetches. Called by `invalidateAccounts`,
 *  since an add/remove/login changes which accounts exist and what they've spent. */
function invalidateLiveUsage(): void {
  liveCache = null;
}

/** Kick a background refresh if the cache is cold. Fire-and-forget by design: the returned promise
 *  is for tests, and no production caller awaits it.
 *
 *  Per-account failures are ABSORBED rather than dropping the whole batch — one account whose token
 *  is missing or whose fetch 401s must not blind selection to the other nine. A failed account
 *  simply has no row, which reads as "unknown".
 *
 *  `now` is INJECTED rather than read from `Date.now()` inside, and both clocks in this module have
 *  to move together: `loadAccountState` already takes one, so a refresh reading the real clock while
 *  the account cache reads a fake one leaves the two indistinguishable in a test — the suite passes
 *  whichever way the TTL is written. */
export function refreshLiveUsage(
  accounts: Account[],
  now: number = Date.now(),
  deps = { fetch: getAccountUsageLive },
): Promise<void> {
  if (liveCache && now - liveCache.at < LIVE_USAGE_TTL_MS) return Promise.resolve();
  if (liveInflight) return liveInflight;
  const p = (async () => {
    const rows = await Promise.all(
      accounts.map((a) =>
        deps
          .fetch(a.configDir)
          .then((r): LiveUsage | null => ({
            id: a.id,
            fiveHourPercent: r?.fiveHourPercent ?? null,
            sevenDayPercent: r?.sevenDayPercent ?? null,
          }))
          .catch(() => null),
      ),
    );
    liveCache = { at: now, rows: rows.filter((r): r is LiveUsage => r !== null) };
  })()
    .catch(() => {
      // Whole-batch failure: leave whatever was cached rather than pinning an empty result, so a
      // transient outage doesn't discard usable figures.
    })
    .finally(() => {
      liveInflight = null;
    });
  liveInflight = p;
  return p;
}

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
      // Kick the live-usage refresh, deliberately NOT awaited — see `refreshLiveUsage`. It costs a
      // keychain read and a network call per account, and a spawn must never wait on either. The
      // rows land for the NEXT pick; this one uses whatever is already cached.
      void refreshLiveUsage(state.accounts, now);
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
  // An add/remove/login changes WHICH accounts exist and which credentials resolve, so the live
  // rows keyed by account id are stale too. Dropping them is safe: until the refresh lands,
  // selection falls back to the local tally rather than to a stale percentage.
  invalidateLiveUsage();
}

/** Choose the account `agentId` should spawn under (honoring its manual pin) plus the loaded state
 *  (for the pane's account badge/dropdown). `chosen` is null only when no accounts exist — then the
 *  spawn omits CLAUDE_CONFIG_DIR and behaves exactly as before accounts existed.
 *
 *  PRECEDENCE, narrowest scope first:
 *    1. this agent's own PIN — one human choice about one agent, and it wins unconditionally;
 *    2. the fleet-wide PREFERRED account ("Activate this account"), when it is still usable —
 *       see `usablePreferredAccount` for why "usable" is a gate here and not for a pin;
 *    3. TRANSCRIPT AFFINITY — the account that already holds this agent's conversation, when the
 *       caller passed a `worktreePath` and that account is still usable. See
 *       `accountHoldingTranscript`;
 *    4. AUTO-PICK — lowest usage among healthy, signed-in accounts, sticky for the two keys that
 *       need it.
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
  opts: {
    force?: boolean;
    now?: number;
    /**
     * This agent's worktree, enabling TRANSCRIPT AFFINITY (precedence 3). Optional because two of
     * the three callers have no worktree to name; omitted → selection behaves exactly as before.
     *
     * The caller supplies it rather than the resolver deriving it because only the caller knows the
     * path — but the RULE lives here, in the one resolver, for the reason this function's header
     * gives: a rule implemented at a call site is a rule the other call sites silently don't have.
     */
    worktreePath?: string;
    /** Injectable probe, so the affinity rule is testable without Tauri. Defaults to the real IPC. */
    sessionAccounts?: (
      worktreePath: string,
      configDirs: string[],
    ) => Promise<string[]>;
    /** Treat a CLOBBERED default (shared `$HOME/.claude` now signed into a different account, or a dir
     *  a different account took over recently) as unhealthy for auto-pick, so a dedicated account is
     *  preferred and routing goes AWAY from the fragile default (see {@link clobberedDefaultIds} /
     *  {@link PickOptions.clobberedIds}). Opt-in — only the concierge sets it — so other callers are
     *  unchanged. `leastBad` still returns the clobbered default when it is genuinely the only account. */
    avoidClobberedDefault?: boolean;
  } = {},
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
  if (remembered) {
    // `candidates: null`, NOT `[]`. This branch runs only when the backend could not be read, so
    // there is no pool to report — and `[]` is already spoken for: it means "evaluated, and every
    // account was over its line". Passing the empty array would file a transient IPC hiccup as a
    // fleet-wide exhaustion event in the one file written to be trusted later.
    logSelection(agentId, remembered, "remembered", state, null);
    return { chosen: remembered, state };
  }
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
    // The COMPLEMENT of the line above, and it rides the shared base for the same reason
    // everything else here does. It only ever bites when `signedInIds` carries no usable
    // signal and the filter degrades open: without it, a config dir positively read as having
    // no login still wins auto-pick on its zero tally, which is sparkle-gms0 arriving by the
    // back door. It demotes, never blocks — see PickOptions.unauthedIds.
    unauthedIds: new Set(notSignedInAccountIds(state.identities)),
    // The accounts the USER took out of rotation from the accounts screen. Rides the shared base
    // like everything else here, so the pinned branch honours it too — except that a pin is an
    // explicit per-agent override and `pickAccount` lets it win, which is correct: taking an account
    // out of the ROTATION pool is not the same as forbidding a human to send one agent there.
    //
    // A sticky key is exempt from this in ONE place only — see `autoPick`'s `stillHealthy` lookup.
    // Exempting the whole `base` was too wide: `stickySelections` is process-lifetime memory, so the
    // concierge's FIRST turn after every launch runs the fall-through pick, where there is no
    // conversation to strand and no reason to ignore the user's opt-out.
    outOfRotationIds: rotationOutIds(),
    now: opts.now,
    ceilings: state.ceilings,
    // REAL Anthropic utilization, and it rides the shared base for exactly the reason the two above
    // do: both the pinned and the auto-pick branch read it, and building it per-branch is how
    // `signedInIds` got silently lost from one of them once. Whatever the background refresh has —
    // possibly nothing, which degrades to the local-tally rule rather than to a guess.
    live: liveUsageRows(),
    // Login grouping, so the live exclusion is judged PER LOGIN: a duplicate of a spent login whose
    // OWN live fetch failed (no row) is still excluded from the spawn pool via its twin's 99%. This
    // is the SAME per-login judgement `exhaustionOutlook` (AC8) and `switchRecommendation` use, so the
    // spawn gate cannot land agents on a quota those two already call spent.
    siblingIds: loginSiblingIds(state.accounts, state.identities),
    // Only the concierge asks to avoid a clobbered default (`avoidClobberedDefault`); every other
    // caller passes undefined, so `partitionAccounts` sees an absent set and behaves exactly as before.
    // A pin still overrides this — `pickAccount` honours a pinned account even when clobbered, because
    // a human chose it on purpose (the same override that already covers exhausted/near-cap pins).
    clobberedIds: opts.avoidClobberedDefault
      ? clobberedDefaultIds(state.accounts, state.identities)
      : undefined,
  };
  // A pin only counts if it still names a REAL account. Branching on the pin's mere presence let a
  // STALE pin — one left behind by a deleted account — bypass everything below it: `pickAccount`
  // ignores an unmatched `pinnedAccountId` and falls through to plain lowest-usage auto-pick, so a
  // sticky key silently stopped being sticky and recorded nothing. Reachable today, because
  // `setPin` is written for `SPARKLE_AGENT_ID` (its pane is an `AgentPane`) and by `accountSwitch`,
  // while the only `clearPin` caller is the doomed-agent path — nothing prunes a pin when its
  // account is removed. The result was the divergence `isStickyAccountKey` exists to prevent, on
  // the very key it was written for.
  const pin = stickyPin(agentId);
  const pinnedAccountId = pin && state.accounts.some((a) => a.id === pin) ? pin : undefined;
  // Read BEFORE `autoPick`, which writes it. Comparing the sticky key's account across the call is
  // the only way to tell "reused the account it already had" from "picked one fresh" — and that
  // distinction is exactly what a reader of the ledger is looking for, since a sticky key MOVING is
  // a rotation while a sticky key staying put is not.
  const previousSticky = stickySelections.get(agentId);
  // The healthy pool at this instant, evaluated with the SAME options the pick uses. Its emptiness
  // is what separates a real auto-pick from the least-bad fallback, and its size is what tells a
  // reader whether rotation had anything to choose between at all — the founder's machine has one
  // signed-in account, where every pick is unanimous and therefore proves nothing on its own.
  // NULL WHEN THE BACKEND FAILED, even though `eligibleAccounts` happily returns [] for the EMPTY
  // snapshot. This path is reached with `state.failed` on a key's FIRST-ever resolution — there is
  // nothing remembered to carry it, so it falls through here rather than into the branch above. An
  // empty array there is a measured claim ("evaluated, nothing healthy") produced by a read that
  // never happened, and it is byte-identical to a genuinely empty registry: `signedInCount: 0`,
  // `accountId: null`, `reason: "none"`. An IPC hiccup would be indistinguishable from "you have no
  // accounts" forever after, in the file written to be trusted later.
  const candidates = state.failed
    ? null
    : eligibleAccounts(state.accounts, state.usage, base);
  // The FLEET-WIDE preference, third in precedence and only when the pin did not already answer.
  // Evaluated here rather than inside `autoPick` so the ledger can name it: "the human activated
  // this account" and "it happened to have the lowest tally" are different facts about the same
  // outcome, and a reader of the log needs to tell them apart.
  const preferredAccountId = pinnedAccountId
    ? undefined
    : usablePreferredAccount(agentId, state, base.signedInIds, opts.now);
  // TRANSCRIPT AFFINITY. The PROBE runs whenever a worktree was named — even under a pin or a
  // preference, which cannot be overridden — because its answer is needed for TWO different things
  // and only one of them is the choice. The other is the warning below, and that is precisely the
  // case a human choice creates: activating an account fleet-wide moves every agent off its own
  // conversation at once, and skipping the probe there would make the largest instance of this
  // failure the one nothing reports.
  const holders = await accountsHoldingTranscript(state, opts);
  const transcriptAccountId =
    pinnedAccountId || preferredAccountId
      ? undefined
      : firstUsableHolder(holders, state, base, opts.now)?.id;
  // ROTATION IS PAUSED — the fleet-wide control the founder asked for ("I could pause the fleet
  // rotation… it pauses the rotation across all of them").
  //
  // WHAT PAUSING MEANS, precisely, because the word admits a much worse reading. It does NOT stop
  // spawns: a glance-level toggle that silently takes the fleet down is the one outcome nobody would
  // forgive, and "pause" is not what anyone would call it. It stops the thing rotation actually DOES
  // — re-ranking accounts by headroom on every spawn — and keeps sending new agents to the account
  // rotation was on when it was paused.
  //
  // FOURTH IN PRECEDENCE, below transcript affinity, and that placement is the load-bearing part. A
  // freeze is a statement about WHICH ACCOUNT ROTATION PICKS, and transcript affinity is not a
  // rotation decision at all — it is the only account that can resume an agent's existing
  // conversation. Ranking the freeze above it would answer "don't re-rank the pool" by silently
  // starting agents blank, which is the failure `transcript` exists to prevent and the one no UI
  // surface can show.
  //
  // Degrades exactly like the preference above it: `usablePausedAccount` drops a frozen id that no
  // longer names a real, signed-in, unexhausted account, and the spawn falls through to ordinary
  // auto-pick. A pause whose target went away must not strand the fleet.
  const pausedAccountId =
    pinnedAccountId || preferredAccountId || transcriptAccountId
      ? undefined
      : usablePausedAccount(agentId, state, base.signedInIds, opts.now);
  const chosen = pinnedAccountId
    ? pickAccount(state.accounts, state.usage, { ...base, pinnedAccountId })
    : preferredAccountId
      ? // Routed through `pickAccount`'s pin slot rather than plucked out of the list, so the
        // preferred account is resolved by the SAME function every other path uses. The gate above
        // is what keeps this from inheriting the pin's override power.
        pickAccount(state.accounts, state.usage, { ...base, pinnedAccountId: preferredAccountId })
      : transcriptAccountId
        ? pickAccount(state.accounts, state.usage, {
            ...base,
            pinnedAccountId: transcriptAccountId,
          })
        : pausedAccountId
          ? pickAccount(state.accounts, state.usage, { ...base, pinnedAccountId: pausedAccountId })
          : autoPick(agentId, state, base);
  const reason: SelectionReason = pinnedAccountId
    ? "pinned"
    : preferredAccountId
      ? "preferred"
      : transcriptAccountId
        ? "transcript"
        : pausedAccountId
          ? "paused"
          : !chosen
            ? "none"
            : isStickyAccountKey(agentId) && previousSticky === chosen.id
              ? "sticky"
              : candidates != null && candidates.length === 0
                ? "fallback"
                : "auto";
  // NEVER SILENT. We are about to launch under an account that does NOT hold this agent's
  // conversation, so it will come up FRESH — the exact state that read as "spawned with no task",
  // and the one thing no UI surface can show (the row, the header and the brief all keep rendering).
  //
  // Placed AFTER `chosen` rather than inside the affinity helper on purpose: the question is about
  // the account we actually settled on, so this fires for a pin and for the fleet preference too,
  // not just for the exhausted-holder case. Those are the instances that move MANY agents at once.
  if (holders.length > 0 && chosen && !holders.some((h) => h.id === chosen.id)) {
    console.warn(
      "the account holding this agent's conversation is not the one it will run under — it will " +
        "start a FRESH session and its prior context (including any opening brief) is not resumed",
      {
        agentId,
        worktreePath: opts.worktreePath,
        chosen: chosen.id,
        reason,
        holders: holders.map((h) => h.id),
      },
    );
  }
  logSelection(agentId, chosen, reason, state, candidates);
  // STICKY BOOKKEEPING, for the branches that never reach `autoPick` — which is the only writer of
  // `stickySelections`. Affinity made that gap load-bearing: Improve Sparkle is resolved by BOTH an
  // ordinary `AgentPane` (which now names a worktree, so affinity can answer) and the headless
  // hourly pass (which names none, so it cannot). Without this line the pane's affinity answer would
  // leave the sticky slot unwritten and the pass would auto-pick fresh — landing the two on
  // DIFFERENT accounts for ONE SHARED WORKTREE, which is the precise failure `isStickyAccountKey`
  // exists to prevent, reintroduced through the door affinity opened.
  if (chosen && isStickyAccountKey(agentId)) stickySelections.set(agentId, chosen.id);
  // Remember it so the branch above can carry this key through a later hiccup.
  if (chosen) lastResolvedAccount.set(agentId, chosen);
  return { chosen, state };
}

/**
 * The account that already HOLDS this agent's conversation, when it is still a usable choice.
 *
 * ══ WHY AN AGENT'S ACCOUNT CANNOT BE RE-PICKED FREELY ═════════════════════════════════════════
 *
 * A `claude` conversation is stored under the `CLAUDE_CONFIG_DIR` it ran with. So the account is not
 * just "whose quota pays" — it decides WHICH HISTORY the agent can see, and moving an agent between
 * accounts strands its conversation in a tree the new spawn will never look in. `isStickyAccountKey`
 * already says this for the concierge, in those words. It excluded build agents on a premise stated
 * in its own comment — *"A build agent resolves its account once, at spawn, so re-picking costs it
 * nothing"* — and that premise is false. A build agent re-resolves on EVERY remount: a pane
 * reopening, a "Start again", and above all the resurrection sweep that runs after an app restart.
 *
 * Measured, on one agent, on one morning: it spawned at 12:09 under account A and took its opening
 * brief; A began rate-limiting an hour later; the app restarted at 14:05 and resurrected 111 agents;
 * the remount re-picked by lowest usage, landed on account B, correctly found no session under B,
 * and launched claude fresh and empty. Its hour of work and its brief were intact under A the whole
 * time. Nothing surfaced it — the row, the pane header and the brief all still rendered — so it
 * presented as *"build agents are being created with no task"* and as *"mounting an agent shows an
 * empty terminal"*, and was attributed to an unrelated UI change for most of a day.
 *
 * ══ WHY NOT JUST MAKE BUILD AGENTS STICKY ═════════════════════════════════════════════════════
 *
 * `stickySelections` is process-lifetime memory, and its own comment explains why that is fine for
 * the keys that use it: *"a restart re-picks, which is correct — there is no live conversation to
 * keep continuity with."* An app restart is exactly when that stops being true and exactly when this
 * bug fires, because the resurrection sweep re-mounts agents whose conversations are on disk. Only
 * the DISK can answer this across a restart, so affinity reads the transcript tree rather than
 * process memory.
 *
 * ══ WHAT IT DELIBERATELY DOES NOT DO ══════════════════════════════════════════════════════════
 *
 * It does not outrank a human. A pin and the fleet preference are both decisions someone made on
 * purpose, and affinity only DECIDES when neither answered. The probe still runs under both, because
 * its answer also drives the "this agent will come up blank" warning — and a fleet-wide preference
 * is the single biggest instance of that, moving every agent off its own conversation at once.
 *
 * It does not park an agent on a dead account: an exhausted holder is skipped, exactly as
 * `usablePreferredAccount` skips an exhausted preference. That case is REAL — the measured agent's
 * account was rate-limiting when it moved — and it is a genuine loss of continuity that no selection
 * rule can prevent. What it must not be is SILENT, which is what cost the day.
 *
 * Best-effort throughout: a probe that throws yields no holders and selection proceeds on usage
 * alone. A resume that could not be arranged is worth a warning, never a failed spawn.
 *
 * Returns ACCOUNTS, newest-transcript first, WITHOUT filtering for usability — the caller needs the
 * unfiltered set to tell "no account holds this" (nothing to preserve) from "the holder is unusable"
 * (continuity is being lost right now).
 */
async function accountsHoldingTranscript(
  state: AccountState,
  opts: {
    worktreePath?: string;
    sessionAccounts?: (worktreePath: string, configDirs: string[]) => Promise<string[]>;
  },
): Promise<Account[]> {
  const worktreePath = opts.worktreePath;
  if (!worktreePath) return [];
  // No accounts configured → nothing to be loyal to, and the spawn omits CLAUDE_CONFIG_DIR anyway.
  // `state.failed` means the account list is UNKNOWN rather than empty: probing it would ask about
  // an empty set and answer "no account holds this", which is a measured-sounding claim produced by
  // a read that never happened — the same trap `candidates: null` exists for above.
  if (state.failed || state.accounts.length === 0) return [];
  // DEDUPED, because two registered accounts can share one config dir (the same login added twice).
  // The probe answers per DIRECTORY, so sending a duplicate would return that directory twice and
  // make the same conversation look like two holders.
  const configDirs = [...new Set(state.accounts.map((a) => a.configDir ?? ""))];
  let holders: string[];
  try {
    holders = await (opts.sessionAccounts ?? claudeSessionAccounts)(worktreePath, configDirs);
  } catch (e) {
    console.warn("transcript affinity probe failed; selecting on usage alone", e);
    return [];
  }
  // Map each holding config dir back to EVERY account naming it, newest-transcript order preserved.
  // `flatMap` rather than `find`: when several accounts share a dir they are all equally holders of
  // that conversation, and collapsing onto the first would hide a usable one behind an exhausted
  // duplicate. Comparing on `configDir` is also what makes the default account's `""` resolve to
  // itself rather than to whichever other account also records no override.
  return holders.flatMap((dir) => state.accounts.filter((a) => (a.configDir ?? "") === dir));
}

/** The first holder we may actually launch under, or undefined when none is usable.
 *
 *  THREE gates, the same three AUTO-PICK applies, so transcript affinity cannot resume a spawn under
 *  an account a fresh pick would have refused:
 *   1. SIGNED IN — an account nobody signed into strands the agent at a login prompt;
 *   2. NOT AT THE OBSERVED WALL — an `exhaustedUntil` in the future strands it at a rate limit;
 *   3. NOT LIVE-SPENT — Anthropic's OWN utilization (`isAccountLiveSpent`, ≥ `LIVE_AVOID_PERCENT`)
 *      is the proactive-avoid signal `partitionAccounts` already excludes on. Resuming under a holder
 *      Anthropic reports at or above `LIVE_AVOID_PERCENT` lands the agent close to a wall it will hit
 *      within the session, then move accounts MID-TASK (a proactive move has no stale-resume retry, by
 *      design) — worse than moving now. This is the SAME move-and-warn the exhausted-holder case
 *      already makes; live-spent
 *      is FACT, not the retired learned-ceiling estimate, so aligning the two is a tightening, not a
 *      new heuristic.
 *
 *  This does NOT match `usablePreferredAccount`, which stops at gates 1–2: a human who explicitly
 *  activated an account is entitled to keep using it while it is busy, and transcript affinity is an
 *  AUTOMATIC continuity preference with no such choice to respect.
 *
 *  SAFE against emptying the pool: returning undefined only falls through to `autoPick`, which still
 *  returns an account. When the live-spent holder is the ONLY account, `autoPick`'s all-excluded
 *  fallback (`leastBad`) returns it anyway, so continuity is preserved and no spawn is blocked. */
function firstUsableHolder(
  holders: Account[],
  state: AccountState,
  base: PickOptions,
  now: number = Date.now(),
): Account | undefined {
  // `signedInFilterApplies`, not `signedInIds.length > 0` — see its doc comment. A reading whose
  // only entries name accounts that no longer exist is NOT a usable signal, and counting it as one
  // rejected every holder here while `partitionAccounts` was simultaneously opening the pool.
  const applies = signedInFilterApplies(state.accounts, base.signedInIds);
  return holders.find(
    (a) =>
      (!applies || base.signedInIds!.includes(a.id)) &&
      !isAccountExhausted(state.usage, a.id, now) &&
      !isAccountLiveSpent(a.id, base.live, base.siblingIds),
  );
}

/** Append this resolution to the on-disk ledger (`accountLedger.ts`), best-effort.
 *
 *  FIRE AND FORGET, deliberately un-awaited. `chooseAccountForAgent` sits on the spawn path and on
 *  every concierge turn; awaiting an IPC round-trip here would put the ledger between the user and
 *  their agent starting. `recordSelection` never rejects, so there is no unhandled rejection to
 *  leak — losing a log line is always cheaper than delaying a spawn.
 *
 *  The COUNTS are the point, not just the chosen id. `signedInCount` is what makes an unanimous pick
 *  legible: with one signed-in account every spawn lands on the same account no matter how good the
 *  selection rule is, and a log that recorded only the winner would look identical to a broken
 *  rotation. Recording how many accounts were even allowed to compete is what tells those two apart
 *  after the fact. */
function logSelection(
  key: string,
  chosen: Account | null,
  reason: SelectionReason,
  state: AccountState,
  /** The healthy pool, or NULL when it was never evaluated (the backend was unreadable). The two are
   *  different facts and the ledger records them differently — see the `remembered` call site. */
  candidates: Account[] | null,
): void {
  if (!shouldLogSelection(key, chosen?.id ?? null, isStickyAccountKey(key))) return;
  // `state` is the EMPTY snapshot whenever candidates are null, so every lookup below would return
  // its "nothing found" answer — which is indistinguishable from a real zero. Decide once, here,
  // that nothing was measured, rather than letting each field quietly default.
  const measured = candidates != null;
  const usage = chosen ? state.usage.find((u) => u.id === chosen.id) : undefined;
  const ceiling = chosen
    ? (state.ceilings.find((c) => c.id === chosen.id)?.ceiling ?? null)
    : null;
  const tokens5h = measured ? (usage?.tokens5h ?? 0) : null;
  const entry: SpawnLogEntry = {
    at: Date.now(),
    key,
    accountId: chosen?.id ?? null,
    nickname: chosen?.nickname ?? null,
    configDir: chosen?.configDir ?? null,
    // The authenticated identity, NOT the nickname — a user-typed nickname has no bearing on which
    // login a config dir actually holds, and on this machine one is literally named for the wrong
    // account.
    email: chosen ? (state.identities.find((i) => i.id === chosen.id)?.email ?? null) : null,
    reason,
    tokens5h,
    ceiling,
    // Guarded against a zero/absent ceiling rather than dividing blind: null is a real answer here
    // and must never be coerced to 0, which would render an unmeasured account as the emptiest one.
    fraction:
      tokens5h != null && ceiling != null && ceiling > 0 ? tokens5h / ceiling : null,
    eligibleCount: candidates?.length ?? null,
    // Null rather than 0 when unmeasured. Zero here would state "nobody is signed in", which is the
    // single most alarming thing this file can say, on the strength of no observation at all.
    signedInCount: measured ? signedInAccountIds(state.identities).length : null,
    candidateIds: candidates?.map((a) => a.id) ?? null,
  };
  void recordSelection(entry);
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
    // A STICKY KEY IS KEPT ON ITS ACCOUNT WHILE THAT ACCOUNT IS STILL ELIGIBLE — it is not re-picked
    // to the lowest-usage account every turn. Moving it runs `rebindSessionToAccount` (both session
    // pointers nulled, conversation re-probed), and a PROACTIVE move has no stale-resume retry by
    // design, so it would die silently with nobody having asked for it. So the key moves only when
    // its account becomes genuinely INELIGIBLE — an OBSERVED rate limit (`exhaustedUntil`) or real
    // Anthropic utilization at/above `LIVE_AVOID_PERCENT`, both FACTS.
    //
    // There used to be an extra asymmetry here: the learned-ceiling ESTIMATE was withheld
    // (`ceilings: undefined`) so it could not evict a live conversation. That is now redundant — the
    // estimate was retired as a selection driver and gates NEITHER keep nor first-pick — so keep and
    // first-pick share one eligibility rule and no `ceilings` override is needed.
    // …AND A KEBAB CLICK IS NOT ONE OF THOSE FACTS. `outOfRotationIds` is withheld HERE and only
    // here, which is the whole of the sticky exemption. Without it, taking the concierge's current
    // account out of rotation makes it ineligible on the next turn and relocates a LIVE session —
    // a proactive move triggered by a menu item, which is exactly what the paragraph above says must
    // not happen. Withholding it on the FIRST pick instead would be a different and worse bug: that
    // branch runs on every launch (`stickySelections` is process-lifetime), strands nothing, and
    // would put the concierge on an account whose own card reads "out of rotation".
    //
    // This is the same shape the retired `ceilings: undefined` override had, for the same reason —
    // keep is judged on observed fact, first-pick on the full rule.
    const stillHealthy = eligibleAccounts(state.accounts, state.usage, {
      ...base,
      outOfRotationIds: undefined,
    }).find((a) => a.id === previousId);
    if (stillHealthy) return stillHealthy;
  }
  // FIRST pick for this key (or its previous account just became ineligible): ordinary auto-pick —
  // lowest real/observed usage, exactly as a fresh spawn. There is no conversation to strand yet.
  const chosen = pickAccount(state.accounts, state.usage, base);
  if (chosen) stickySelections.set(agentId, chosen.id);
  return chosen;
}

/** The fleet-wide preferred account, IF it is safe to honour for this key right now — else
 *  undefined, and the caller falls through to auto-pick.
 *
 *  THE GATE IS THE FEATURE. A pin beats everything: `pickAccount` honours it for an account that is
 *  exhausted, near its cap, or never signed into, because one human named one agent and one account
 *  (see `PickOptions.pinnedAccountId`). Giving the FLEET-WIDE preference that same power would turn
 *  a one-agent mistake into an outage — activate an account, sign out of it, and every subsequent
 *  spawn in the app opens on a login prompt with nothing on screen explaining why. So the preference
 *  is honoured only while it still describes a usable account, and the moment it does not, selection
 *  behaves exactly as it did before the feature existed.
 *
 *  Four conditions, each a way this has to be able to fail safely:
 *
 *  1. NOT FOR A STICKY KEY. The concierge and Improve Sparkle are sticky by design
 *     (`isStickyAccountKey`) and moving the concierge mid-conversation makes `rebindSessionToAccount`
 *     null both session pointers and re-probe. "Activate this account" is about the agent fleet; the
 *     two sticky consumers get their own explicit control in the accounts modal, which writes a PIN
 *     on their key — a deliberate, per-consumer choice rather than a side effect of a fleet setting.
 *  2. THE BACKEND MUST HAVE ANSWERED. With `state.failed` every account looks absent, so both the
 *     "is it real" and "is it signed in" tests below would fail for reasons that say nothing about
 *     the account. Decline to act — and, critically, decline to CLEAR (see 3).
 *  3. IT MUST NAME A REAL ACCOUNT — ignored here, and PRUNED where the account is actually removed
 *     (`removeAccount`), not here. The prune matters: nothing prunes a stale pin when its account is
 *     deleted, which is precisely how a sticky key silently stopped being sticky (see the pin note
 *     in `chooseAccountForAgent`), and a preference outliving its account would be the same bug with
 *     a wider blast radius. But this is the wrong PLACE to do it, because `state` is served from a
 *     cache `loadAccountState` documents as up to `ACCOUNT_CACHE_TTL_MS` stale and invalidated only
 *     by the window that made the change. A preference set on a freshly added account would be
 *     observable as "not a real account" by another window and permanently erased from shared
 *     `localStorage` — a silent, irreversible write derived from a stale read. `removeAccount` is
 *     authoritative about a removal in a way a spawn-path snapshot can never be, so the deletion
 *     happens there and the spawn path merely declines to act.
 *  4. SIGNED IN, AND NOT AT AN OBSERVED LIMIT. Never strand a spawn at a login prompt, and never
 *     send work to an account that just answered with a rate limit. Deliberately NOT the full
 *     `eligibleAccounts` test: near-cap and near-ceiling are ESTIMATES, and a human who explicitly
 *     activated an account is entitled to keep using it while it is merely busy. Only observed fact
 *     overrides an explicit choice. */
function usablePreferredAccount(
  agentId: string,
  state: AccountState,
  signedInIds: readonly string[],
  now: number | undefined,
): string | undefined {
  if (isStickyAccountKey(agentId)) return undefined; // (1)
  const preferred = getPreferredAccountId();
  if (!preferred) return undefined;
  if (state.failed) return undefined; // (2) — unreadable, so nothing below means anything
  if (!state.accounts.some((a) => a.id === preferred)) return undefined; // (3)
  // (4) — and ONLY when the signal exists. See `signedInAccountIds`: it keys on `Identity.email`,
  // which `accounts.rs` leaves null for any config dir whose `.claude.json` carries no
  // `oauthAccount` or could not be parsed. On such an install EVERY account reads "not signed in",
  // and a bare `includes` would silently drop the founder's choice on every spawn, permanently,
  // with the ledger recording a bland "auto". `partitionAccounts` already refuses to let an absent
  // signal mean "nothing is usable"; the gate degrades the same way, so the two cannot disagree
  // about what an empty list means. That agreement is now ENFORCED rather than asserted: both call
  // `signedInFilterApplies`. They used to disagree — this gate keyed on raw length while
  // `partitionAccounts` keyed on membership, so a reading holding only a STALE id (an identity that
  // outlived its account row) read as "signal present" here and "no signal" there, and the
  // preferred account was dropped on every spawn.
  if (signedInFilterApplies(state.accounts, signedInIds) && !signedInIds.includes(preferred))
    return undefined;
  if (isAccountExhausted(state.usage, preferred, now ?? Date.now())) return undefined; // (4)
  // 5. NOT TAKEN OUT OF ROTATION. One rule for both FLEET-LEVEL mechanisms — this and the pause —
  //    and never for a per-agent pin. Both of these are the user's own choice, so the tie is broken
  //    by which one the SCREEN is showing: the card renders "out of rotation · you took it out", and
  //    honouring a fleet preference onto it would put the dot and the router back in contradiction,
  //    which is the whole defect this surface was rebuilt to remove. A pin stays exempt because it
  //    names one agent and one account deliberately — "out of the rotation pool" was never "nobody
  //    may send anything here".
  if (rotationOutIds().has(preferred)) return undefined;
  return preferred;
}

/** The account rotation was FROZEN onto when it was paused, if it is still safe to honour — else
 *  undefined, and the caller falls through to auto-pick.
 *
 *  THE SAME GATE, FOR A WEAKER CLAIM. `usablePreferredAccount` above guards a human saying "run my
 *  agents HERE"; this guards a human saying "stop moving them", which names an account only as a side
 *  effect. So every way that gate can fail safely, this one must too — an unreadable backend, an
 *  account that was removed, a login that went away, an observed rate limit — and each falls through
 *  to ordinary auto-pick rather than stranding the spawn. A pause is a convenience; it is never worth
 *  a dead agent.
 *
 *  STICKY KEYS ARE EXEMPT, exactly as they are from the preference (condition 1 there). The concierge
 *  and Improve Sparkle are sticky by design and moving the concierge mid-conversation re-probes both
 *  session pointers. Pausing rotation is a statement about the AGENT FLEET; those two have their own
 *  explicit control in the accounts modal.
 *
 *  NOT PRUNED HERE when the frozen account is gone, for the reason spelled out at (3) above: `state`
 *  is served from a cache that another window may not have invalidated, so a silent, irreversible
 *  write to shared `localStorage` derived from a stale read is exactly the wrong move. Declining to
 *  act is enough — the pause simply stops biting, and the header still says rotation is paused, which
 *  is true. */
function usablePausedAccount(
  agentId: string,
  state: AccountState,
  signedInIds: readonly string[],
  now: number | undefined,
): string | undefined {
  if (isStickyAccountKey(agentId)) return undefined;
  const pause = rotationPause();
  if (!pause?.accountId) return undefined; // not paused, or paused with nothing frozen
  const frozen = pause.accountId;
  if (state.failed) return undefined;
  if (!state.accounts.some((a) => a.id === frozen)) return undefined;
  // TAKEN OUT OF ROTATION BEATS THE FREEZE, and this gate cannot be left to `partitionAccounts`:
  // the frozen id is routed through `pickAccount`'s pin slot, which returns a pinned account
  // OUTRIGHT, before the partition runs. Without this, one gesture produces the exact contradiction
  // this whole screen was rebuilt to remove — pause the fleet while it is on X, then take X out from
  // its kebab, and every spawn keeps landing on X under a card reading "out of rotation — you took
  // it out". A pause names an account only as a SIDE EFFECT of declining to re-rank, so it has no
  // standing to override a choice the user made about that account directly.
  if (rotationOutIds().has(frozen)) return undefined;
  if (signedInFilterApplies(state.accounts, signedInIds) && !signedInIds.includes(frozen))
    return undefined;
  if (isAccountExhausted(state.usage, frozen, now ?? Date.now())) return undefined;
  return frozen;
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
export const SPARKLE_SELF_ACCOUNT_PREFIX = "__sparkle_self__";

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

/** This key's pin, with ONE namespace rule: an Improve Sparkle window variant
 *  (`__sparkle_self__-win-<uuid>`) inherits the pin written on the base key.
 *
 *  Without it the modal's "Improve Sparkle" control would be a lie in satellite windows. That
 *  control can only write a pin on the key it can name — the base one — while the hourly pass and
 *  the main pane resolve under that key and each satellite window resolves under its own variant.
 *  Pinning would then park some of the namespace and leave the rest auto-picking, which is exactly
 *  the split-across-accounts-in-one-worktree failure `isStickyAccountKey` exists to prevent. The
 *  variant's OWN pin still wins if one is ever written; this is a fallback, not an override. */
function stickyPin(agentId: string): string | undefined {
  const own = getPin(agentId);
  if (own) return own;
  return agentId.startsWith(`${SPARKLE_SELF_ACCOUNT_PREFIX}-`)
    ? getPin(SPARKLE_SELF_ACCOUNT_PREFIX)
    : undefined;
}

/** What account a key is currently parked on, for DISPLAY only — its pin if it has one, else the
 *  account it last settled on in this process. READ-ONLY BY DESIGN: the accounts modal needs to say
 *  "the concierge is on Work" without *causing* a resolution, and calling `chooseAccountForAgent`
 *  to find out would write `stickySelections`, append a ledger line, and record a spawn that never
 *  happened. Undefined means "nothing chosen yet in this process", not "no account". */
export function stickyAccountSnapshot(key: string): string | undefined {
  return stickyPin(key) ?? stickySelections.get(key);
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

/** How long a reactively-detected-dead account is benched so a sticky consumer rotates OFF it.
 *
 *  SHORT on purpose — this is a reactive NUDGE to move the concierge NOW, not the authoritative
 *  reset window:
 *   - For a QUOTA wall, `limitSync` reads the REAL reset instant from the account's own transcript
 *     within one poll (`LIMIT_POLL_MS`) and EXTENDS the bench to it (`pendingExhaustions` only ever
 *     lengthens a bench, never shortens one), so a short reactive bench can never make an account
 *     return to the pool before its true reset.
 *   - For an AUTH expiry there is no reset instant at all — the account is dead until the human
 *     re-signs in — and recorded state cannot see the expiry, so nothing else will ever bench it.
 *     A short bench lets it back into the pool once the window passes; stickiness keeps the consumer
 *     on the healthy account it moved to, so a still-dead account is only ever re-picked (and
 *     re-benched on its next failure) if that healthy account also dies in the meantime.
 *  Long enough to outlast the immediate re-resolve below, short enough not to strand a recovered
 *  account. */
export const REACTIVE_BENCH_MS = 5 * 60_000;

/** Outcome of {@link rotateStickyConsumerOffFailedAccount}. `rotated` is the side effect a caller or
 *  test asserts; the rest is provenance for the ledger/logs and for the paired negative tests. */
export interface StickyRotationResult {
  rotated: boolean;
  /** The account the consumer was parked on when the failure arrived, if any. */
  from?: string;
  /** The account it moved TO, when it rotated. */
  to?: string;
  /** Why it did NOT rotate — for logging and to let a test distinguish the guards. */
  reason?:
    | "not-unusable"
    | "pinned"
    | "nothing-resolved"
    | "backend-unreadable"
    | "no-healthy-alternative";
}

/**
 * Reactively rotate a STICKY consumer (the concierge, Improve Sparkle) OFF the account it just
 * failed under, when the failure proves that account is unusable — an expired OAuth session or a
 * quota/rate-limit wall (bead sparkle-08mq3t).
 *
 * ══ WHY THE STICKY EVICTION IS NOT ENOUGH ON ITS OWN ══════════════════════════════════════════
 * {@link autoPick} already moves a sticky key when its account stops being eligible — but "eligible"
 * is judged from RECORDED state, and an OAuth expiry leaves NO trace there: the account's
 * `.claude.json` still carries an `oauthAccount`, so {@link signedInAccountIds} still lists it and
 * {@link eligibleAccounts} still calls it healthy. The concierge therefore stays pinned to a dead
 * account and every turn fails with "OAuth session expired" — exactly the founder's report, with
 * three healthy accounts sitting right there and no way out but restarting the app. Recorded state
 * cannot detect this; the turn FAILURE is the only signal, so rotation is driven reactively from it.
 *
 * ══ HOW — REUSING THE EXISTING PREDICATE, NOT A NEW ONE ═══════════════════════════════════════
 * The failed account, and its whole LOGIN group (one dead OAuth session kills every registration of
 * it, and one wall belongs to the login, not the config dir — the same fan-out `limitSync` does),
 * is benched via {@link markExhausted}. That is the one mechanism {@link eligibleAccounts} and
 * {@link pickAccount} already honour, so the next resolution evicts it through `autoPick`'s ordinary
 * keep-vs-repick path and lands on the lowest-usage healthy account. The re-resolve here moves the
 * sticky pointer too, so the consumer's NEXT turn is already stable on the new account.
 *
 * ══ SAFETY — every guard is a way this must fail safely ═══════════════════════════════════════
 *  - Only on a genuine unusability signal (`auth`/`quota`), never `unknown`: a transient 529 must
 *    not evict a healthy account.
 *  - A human PIN wins (Manual Override). A pinned consumer is left exactly where the human put it.
 *  - It benches ONLY when a healthy alternative exists. If every other account is unusable too, it
 *    does nothing: the consumer stays put and its next turn fails into the EXISTING sign-in path,
 *    which is the correct dead-end. It never benches the fleet down to nothing and never manufactures
 *    a null account.
 *  - Best-effort and never throws: a rotation that cannot be arranged leaves selection untouched.
 *
 * Fire-and-forget from the failure handler — the failing turn is already lost; this makes the NEXT
 * one land on a live account instead of requiring an app restart.
 */
export async function rotateStickyConsumerOffFailedAccount(
  key: string,
  kind: ConciergeFailureKind,
  opts: { now?: number } = {},
): Promise<StickyRotationResult> {
  try {
    // A transient/unclassified failure is NOT evidence the account is dead — do not evict on it.
    if (kind !== "auth" && kind !== "quota") return { rotated: false, reason: "not-unusable" };
    // A human's explicit Manual Override outranks reactive rotation.
    if (getPin(key)) return { rotated: false, reason: "pinned" };
    // The account the consumer actually ran under is its sticky selection. With nothing resolved yet
    // there is no failed account to move off of.
    const from = stickySelections.get(key);
    if (!from) return { rotated: false, reason: "nothing-resolved" };

    const now = opts.now ?? Date.now();
    const state = await loadAccountState({ force: true, now });
    // Unreadable backend: every account looks absent, so we can neither identify a healthy
    // alternative nor trust that `from` is really dead. Leave selection alone.
    if (state.failed) return { rotated: false, reason: "backend-unreadable" };

    // The dead LOGIN group, not just the one config dir — a dead OAuth session or a walled quota is
    // a property of the login, and benching one registration while its twin reads healthy would just
    // rotate the concierge straight onto the sibling and re-hit the identical failure.
    const siblings = loginSiblingIds(state.accounts, state.identities);
    const deadIds = new Set(siblings.get(from) ?? [from]);

    // "Is there a healthy alternative" is asked with the SAME options the re-resolve will use, so the
    // two cannot disagree about what "healthy" means.
    const base = {
      signedInIds: signedInAccountIds(state.identities),
      unauthedIds: new Set(notSignedInAccountIds(state.identities)),
      now,
      ceilings: state.ceilings,
      live: liveUsageRows(),
      siblingIds: siblings,
    };
    const hasAlternative = eligibleAccounts(state.accounts, state.usage, base).some(
      (a) => !deadIds.has(a.id),
    );
    // SAFETY: never bench the fleet down to nothing. With no healthy alternative, leave the consumer
    // on its (dead) account so its next turn fails into the existing sign-in dead-end rather than a
    // null-account spawn — the behaviour the founder's flow already relies on when truly everything
    // is out.
    if (!hasAlternative) return { rotated: false, from, reason: "no-healthy-alternative" };

    // Bench the dead login group so the existing eligibility predicate evicts it. Best-effort per id;
    // a failed write simply leaves that id in the pool, which the next failure re-attempts.
    const until = now + REACTIVE_BENCH_MS;
    await Promise.all(
      [...deadIds]
        .filter((id) => state.accounts.some((a) => a.id === id))
        .map((id) =>
          markExhausted(id, until).catch((e) =>
            console.warn("reactive rotation: markExhausted failed for", id, e),
          ),
        ),
    );
    // Fresh usage now reflects the bench; re-resolve so `autoPick` evicts `from` and the sticky
    // pointer moves to the healthy account, making the consumer's next turn stable.
    invalidateAccountState();
    const { chosen } = await chooseAccountForAgent(key, { force: true, now });
    const to = chosen?.id;
    return { rotated: !!to && to !== from, from, to };
  } catch (e) {
    console.warn("reactive rotation failed; leaving account selection unchanged", e);
    return { rotated: false, reason: "backend-unreadable" };
  }
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
  opts: { force?: boolean; now?: number; avoidClobberedDefault?: boolean } = {},
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

/**
 * The healthy DEDICATED accounts the concierge turn may rotate to when its pinned account's OAuth
 * expires, as their `CLAUDE_CONFIG_DIR`s, ranked best-first — handed to the Rust `concierge_turn` as
 * `fallbackConfigDirs`. When the turn fails with the auth-expiry signature, Rust retries on the first
 * of these instead of re-running the dead account (see `concierge.rs::plan_retry`), so a SINGLE auth
 * failure becomes a rotated retry rather than a "sign in to Claude" dead-end.
 *
 * Built from the SAME selection primitives `pickAccount`/`eligibleAccounts` use, so it cannot develop
 * a second definition of "healthy". Three exclusions, each deliberate:
 *  - the PRIMARY's whole login group — Rust is rotating OFF it, and a sibling shares its dead OAuth;
 *  - CLOBBERED defaults — the shared `$HOME/.claude` fragility this whole change guards against;
 *  - the DEFAULT itself (empty `configDir`) — the concierge rotates to a real dedicated account, never
 *    back onto the shared default, which is exactly what "prefer a dedicated, non-default account"
 *    means. (Rust also skips empty dirs, so this is belt-and-braces.)
 *
 * Ordered by repeatedly asking `pickAccount` for the best of the remaining pool and dropping its whole
 * login group, so the rescued turn lands on the lowest-usage account and no login is offered twice.
 * Returns `[]` on an unreadable backend or when nothing healthy remains — the last-account guard: with
 * no alternative, Rust surfaces the sign-in rather than benching the only account.
 */
export async function conciergeFallbackConfigDirs(
  opts: { force?: boolean; now?: number } = {},
): Promise<string[]> {
  try {
    const { chosen, state } = await chooseAccountForAgent(CONCIERGE_ACCOUNT_KEY, {
      ...opts,
      avoidClobberedDefault: true,
    });
    if (state.failed) return [];
    const now = opts.now ?? Date.now();
    const siblings = loginSiblingIds(state.accounts, state.identities);
    // The primary and everything sharing its login — the group Rust is rotating away from.
    const excluded = new Set<string>(
      chosen ? (siblings.get(chosen.id) ?? [chosen.id]) : [],
    );
    const base = {
      signedInIds: signedInAccountIds(state.identities),
      unauthedIds: new Set(notSignedInAccountIds(state.identities)),
      now,
      ceilings: state.ceilings,
      live: liveUsageRows(),
      siblingIds: siblings,
      clobberedIds: clobberedDefaultIds(state.accounts, state.identities),
    };
    // The healthy pool, minus the primary's group and the shared default (empty configDir).
    let pool = eligibleAccounts(state.accounts, state.usage, base).filter(
      (a) => !excluded.has(a.id) && a.configDir,
    );
    const ordered: string[] = [];
    // `pickAccount` over a pool of only-healthy accounts returns the best of them; drop its login
    // group and repeat, so the list is ranked and deduped by login. Bounded by `pool` shrinking each
    // pass; the guard is defensive against a pick that somehow fails to shrink it.
    while (pool.length > 0) {
      const best = pickAccount(pool, state.usage, base);
      if (!best) break;
      ordered.push(best.configDir);
      const group = new Set<string>(siblings.get(best.id) ?? [best.id]);
      const before = pool.length;
      pool = pool.filter((a) => !group.has(a.id));
      if (pool.length === before) break;
    }
    return ordered;
  } catch (e) {
    console.warn("accountSelection: could not resolve concierge fallbacks; none offered:", e);
    return [];
  }
}
