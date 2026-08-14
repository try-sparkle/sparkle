// Drives the proactive account-switch banner and, once accepted, carries the switch out.
//
// Two phases, deliberately separated:
//
//   1. RECOMMEND — poll headroom; when the account the agents are running on approaches (or hits)
//      its learned ceiling and a better one is available, surface a banner. Nothing happens to any
//      agent. The user decides.
//   2. EXECUTE — on accept, build a plan of every agent on that account and move each one AS IT
//      REACHES A SAFE BOUNDARY (see accountSwitch). Busy agents keep working and migrate when their
//      current turn ends, so no in-flight work is lost. The plan retires when the last one moves.
//
// The banner is a recommendation rather than an automatic action because the underlying estimate is
// good, not exact: measured spread at the moment of a real limit was CoV 0.24. That's ample for
// "you're getting close", and not enough to justify re-spawning someone's fleet unasked.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntimeStore } from "../stores/runtimeStore";
import {
  loadAccountState,
  invalidateAccountState,
  liveUsageRows,
} from "../services/accountSelection";
import {
  listCeilings,
  setPreferredAccountId,
  clearSwitchWrittenPins,
  type Usage,
} from "../services/accountStore";
import { switchRecommendation, type SwitchRecommendation, type Ceiling } from "../services/headroom";
import {
  advanceSwitch,
  planSwitch,
  planSwitchToAccount,
  type SwitchPlan,
} from "../services/accountSwitch";
import { busiestPaneAccount, paneAccountMap, restartPane } from "../services/paneControl";

/** How often to re-evaluate headroom. Slower than the limit poll: the ceiling is cached in Rust for
 *  15 minutes and 5h consumption moves gradually, so a tighter loop would just burn IPC. */
export const HEADROOM_POLL_MS = 120_000;

/** How often to try to advance an accepted switch. Fast, because it's just reading in-memory
 *  statuses — the sooner an agent's turn ends, the sooner it migrates. */
export const SWITCH_ADVANCE_MS = 3_000;

export interface AccountSwitchState {
  /** The current recommendation, or null when nothing is warranted. */
  recommendation: SwitchRecommendation | null;
  /** An accepted switch still in progress, or null. */
  plan: SwitchPlan | null;
  accept: () => void;
  dismiss: () => void;
  /** MANUAL "Activate this account": make `accountId` the fleet's preferred account and move the
   *  agents that aren't on it, each at its own safe boundary. See the callback for the split
   *  between the persisted half and the migration half. */
  switchTo: (accountId: string) => void;
}

export function useAccountSwitch(pollMs: number = HEADROOM_POLL_MS): AccountSwitchState {
  const [recommendation, setRecommendation] = useState<SwitchRecommendation | null>(null);
  const [plan, setPlan] = useState<SwitchPlan | null>(null);
  // Recommendations the user has waved off: `dismissKey` (account AND reason) -> the reason, which
  // `retireStaleWallDismissals` needs to tell the two LIFETIMES apart. Three things are keyed here
  // and each closes a different silence:
  //
  //  - by ACCOUNT, so a fresh recommendation about a DIFFERENT account still shows;
  //  - by REASON, so a wave-off of the ESTIMATE ("stop nagging me that acct-a is getting close")
  //    cannot silence the later, different claim that acct-a HAS hit its wall. Those are not the
  //    same statement and the user only declined one of them;
  //  - and a wall wave-off EXPIRES with the wall it declined, because "I know acct-a is walled
  //    right now" is a statement about one episode, not a standing preference. See the retirement
  //    helper for why an estimate's wave-off is the opposite and does survive the session.
  //
  // The value carries the account and reason rather than having the retirement helper parse them
  // back out of the key: a `key.endsWith(":exhausted")` / `key.split(":")` pair would re-introduce
  // exactly the write/read coupling `dismissKey` exists to remove.
  const dismissed = useRef<Map<string, DismissedClaim>>(new Map());
  // accountId -> the `exhaustedUntil` last OBSERVED for it, so `dismiss` can stamp the episode it is
  // declining onto the claim. Written only on a tick we can believe (`!state.failed`), for the same
  // reason retirement is skipped on one: an unreadable tick would otherwise erase every account's
  // episode and silently downgrade the next wave-off to the weaker membership rule.
  const observedWalls = useRef<Map<string, number | null>>(new Map());
  // The live plan, readable from both interval loops without re-subscribing them on every advance:
  // phase 1 reads it to stay quiet while a switch is running, phase 2 reads it as the input to the
  // next advance. Every path that sets `plan` writes this ref in the same breath, so it never lags;
  // the effect below is a backstop that keeps them in step if a new setter is ever added. Written
  // in effects and callbacks, never during render.
  const planRef = useRef<SwitchPlan | null>(null);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  // ---- phase 1: recommend ---------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const state = await loadAccountState();
        if (cancelled) return;
        let ceilings: Ceiling[] = [];
        try {
          ceilings = await listCeilings();
        } catch {
          // No ceilings → every account reads "unknown" → no recommendation. Degrade quietly.
        }
        if (cancelled) return;
        // Record what this tick SAW before the plan guard below can return early — `dismiss` needs
        // the current episode whenever the user acts, and a banner can still be on screen from an
        // earlier tick while a plan is running.
        if (!state.failed) {
          observedWalls.current = new Map(state.usage.map((u) => [u.id, u.exhaustedUntil ?? null]));
        }
        const current = busiestPaneAccount();
        // The SAME live rows the spawn gate uses (`loadAccountState` kicks the background refresh;
        // `liveUsageRows` returns whatever is cached). Passing them here is what stops an auto-switch
        // migrating the fleet onto an account `pickAccount` would refuse for being live-spent.
        const rec = switchRecommendation(
          current,
          state.accounts,
          state.usage,
          ceilings,
          state.identities,
          Date.now(),
          liveUsageRows(),
        );
        // Suppress while a switch is already running — the answer is "we're on it", not a new ask.
        if (planRef.current) return;

        // Retire wall wave-offs the moment they stop describing anything true. Runs on EVERY
        // evaluation we can BELIEVE, before either branch reads the map, and judges against the
        // OBSERVED exhaustion in `state.usage` rather than against `rec` — see the helper for why.
        //
        // `state.failed` is skipped because a failed load RESOLVES rather than throwing — it hands
        // us `usage: []`, which by row alone is indistinguishable from "nobody is walled" and would
        // retire every live wave-off on one transient hiccup. "We could not look" is not evidence a
        // wall ended, and it costs nothing to skip: `state.accounts` is empty on that tick, so `rec`
        // is null and neither branch below has anything to say anyway.
        if (!state.failed) retireStaleWallDismissals(dismissed.current, state.usage);

        // ══ AN OBSERVED WALL MOVES THE FLEET BY ITSELF; AN ESTIMATE STILL ASKS ═══════════════════
        // `reason: "exhausted"` comes from an observed rate-limit event, and `headroom.ts` says so
        // in its own words: it "is authoritative … so it outranks any estimate". `"approaching"` is
        // the learned ceiling, whose measured CoV of 0.24 is exactly why `headroom.ts` declined to
        // re-spawn a RUNNING fleet unasked. So the two get different answers, and the split is the
        // whole point: act on the fact, ask about the guess.
        //
        // Acting here is safe for the reason the manual path is safe — `advanceSwitch` moves each
        // agent only at a boundary where `isSafeToSwitch` holds, so nothing is re-spawned mid-turn
        // and no in-flight work is lost. And it is worth doing because the alternative is not
        // "wait a moment": an agent behind a session wall is refused by `decideContinuation` until
        // that account's window resets, which for a session limit is up to five hours of a fleet
        // sitting idle on an account it can no longer use.
        //
        // A DISMISSAL DOES NOT SUPPRESS THIS, deliberately. `dismissed` records "don't nag me that
        // this account is getting close" — a wave-off of the prediction. It is not a standing
        // instruction to keep agents parked on an account that has since actually hit its limit,
        // and reading it that way would turn one impatient click into hours of dead fleet.
        if (rec && rec.reason === "exhausted") {
          const fresh = planSwitch(rec.from.id, rec.to.id, paneAccountMap());
          // Nothing mounted to move: fall through to the banner rather than spin an empty plan
          // (phase 2 never retires one), same rule as `accept`.
          if (fresh.pending.length > 0) {
            setRecommendation(null);
            planRef.current = fresh;
            setPlan(fresh);
            return;
          }
        }

        // THE DISMISSAL IS MATCHED ON REASON AS WELL AS ACCOUNT, for the same reason the block
        // above acts. The fall-through gets here in one case that matters: the account HAS hit its
        // wall but nothing mounted can be moved (e.g. every agent on it carries a human pin, so
        // `planSwitch` finds no candidates). That is the case where the automation cannot help and
        // the banner is the ONLY signal left — so a wave-off of the *estimate* must not silence it.
        // A wave-off of the wall banner itself carries the matching key and still does.
        const silenced = rec !== null && dismissed.current.has(dismissKey(rec));
        setRecommendation(silenced ? null : rec);
      } catch (e) {
        console.warn("headroom check failed", e);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  // ---- phase 2: execute -----------------------------------------------------------------------
  //
  // The advance is computed OUTSIDE the `setPlan` updater, and the updater is never used at all.
  // This is load-bearing, not style: `advanceSwitch` re-pins each agent (a persisted write) and
  // re-spawns its PTY. React only guarantees an updater runs with the LATEST state — not that it
  // runs exactly once, and a discarded or replayed render re-invokes it against the same prior
  // state. Inside an updater, that tore down and re-spawned an agent's terminal twice on a single
  // tick (bead sparkle-0t2o). Out here it runs once per interval tick, which is the contract we
  // actually want. `planRef` is the source of truth for the current plan; it is written
  // synchronously below so it can never lag the state it mirrors.
  useEffect(() => {
    if (!plan) return;
    const id = setInterval(() => {
      const cur = planRef.current;
      if (!cur) return;
      const statuses = useRuntimeStore.getState().status;
      const { plan: next, movedNow } = advanceSwitch(cur, statuses, restartPane);
      if (movedNow.length > 0) invalidateAccountState();
      // Retire the plan once everyone has moved, which also re-arms recommendations.
      const settled = next.pending.length === 0 ? null : next;
      planRef.current = settled;
      setPlan(settled);
    }, SWITCH_ADVANCE_MS);
    return () => clearInterval(id);
  }, [plan]);

  const accept = useCallback(() => {
    if (!recommendation) return;
    const fresh = planSwitch(recommendation.from.id, recommendation.to.id, paneAccountMap());
    setRecommendation(null);
    // Nothing running on that account: dismiss the banner rather than leave an empty plan spinning
    // (phase 2 never retires a plan with no pending agents). This records NOTHING — the banner is a
    // recommendation about moving what is running, not a fleet-wide preference; that is what
    // `switchTo` is for. Phase 1 may therefore re-raise the same recommendation on its next pass,
    // which is correct: the account it is warning about is still the one agents will spawn on.
    if (fresh.pending.length === 0) return;
    // Write the ref alongside the state — phase 2 reads the plan from the ref, so it must be
    // current the instant a plan exists rather than one commit later.
    planRef.current = fresh;
    setPlan(fresh);
  }, [recommendation]);

  const dismiss = useCallback(() => {
    if (recommendation) {
      dismissed.current.set(dismissKey(recommendation), {
        accountId: recommendation.from.id,
        reason: recommendation.reason,
        // WHICH episode is being declined. Retirement compares this against the live
        // `exhaustedUntil`, so a later wall is a different claim even if no tick ever saw the gap.
        episode: observedWalls.current.get(recommendation.from.id) ?? null,
      });
    }
    setRecommendation(null);
  }, [recommendation]);

  /** "Activate this account." TWO HALVES, and the first is the one that actually answers the ask.
   *
   *  1. PERSIST THE PREFERENCE — fleet-wide, and the only half that governs agents that do not
   *     exist yet. The switch machinery can only ever reach MOUNTED panes (`paneAccountMap`), so a
   *     migration alone would have been a control whose effect expired the moment the next agent
   *     spawned. This is written FIRST and unconditionally, so it holds even when there is nothing
   *     to move.
   *  2. MIGRATE WHAT IS ALREADY RUNNING — reusing phase 2 above rather than forking it, so the
   *     manual path inherits the safe-boundary rule (nothing is re-spawned mid-turn) for free.
   *
   *  The advance is computed OUTSIDE any `setPlan` updater and `planRef` is written synchronously
   *  alongside the state, exactly as `accept` does — bead sparkle-0t2o. An updater here re-pins and
   *  re-spawns real terminals, and React may replay one.
   *
   *  An EMPTY plan returns after step 1 rather than leaving a plan spinning: phase 2's interval
   *  never retires a plan with no pending agents, so setting one would poll forever. Same reasoning
   *  as `accept`. */
  const switchTo = useCallback((accountId: string): number => {
    // The preference, and the sweep of the pins an EARLIER switch wrote. Both are durable and
    // neither needs this hook, so they live in one place `activateAccount` can reach too.
    recordActivation(accountId);
    // Any standing recommendation is now moot — the user just answered the question it was asking,
    // possibly with a different account than it suggested.
    setRecommendation(null);
    // MOUNTED PANES ONLY. An agent with no pane gains nothing from a plan — there is nothing to
    // re-spawn — and enrolling one would write a pin that OUTRANKS the preference just recorded and
    // survives its removal. `recordActivation` above is what covers those agents, and covers them
    // better; see `planSwitchToAccount`.
    const fresh = planSwitchToAccount(accountId, paneAccountMap());
    if (fresh.pending.length === 0) {
      // An in-flight plan toward a DIFFERENT account must not outlive the answer it was asking for.
      // Phase 2 keeps ticking a surviving plan and re-pins each agent to the OLD target as it
      // reaches a safe boundary — writing pins that outrank the preference just set, so the
      // activation would be undone by a plan the user already superseded. (The banner would also
      // keep reading "Switching accounts…" toward an account nobody chose.)
      if (planRef.current && planRef.current.toAccountId !== accountId) {
        planRef.current = null;
        setPlan(null);
      }
      return 0;
    }
    planRef.current = fresh;
    setPlan(fresh);
    return fresh.pending.length;
  }, []);

  // Publish this hook's lever for the accounts modal, which is nowhere near this hook in the tree
  // (AccountSwitchHost is mounted in App; the modal lives inside the concierge's kebab menu). Same
  // tiny-registry shape as `paneControl` — and for a second reason beyond reachability: ONE plan.
  // Two mounted hooks each holding their own plan would each advance on their own interval, and an
  // agent in both plans would be torn down and re-spawned twice per tick — sparkle-0t2o's harm
  // arrived at from the outside. A single published lever means only one instance ever drives a
  // manual switch.
  useEffect(() => {
    liveSwitchTo = switchTo;
    return () => {
      if (liveSwitchTo === switchTo) liveSwitchTo = null;
    };
  }, [switchTo]);

  return { recommendation, plan, accept, dismiss, switchTo };
}

/** The key a wave-off is recorded under: the account AND the kind of claim being waved off.
 *
 *  Both halves are load-bearing — see the `dismissed` ref. Deriving it in ONE place is what keeps
 *  the write (`dismiss`) and the read (phase 1) from drifting apart; keying them differently is the
 *  whole defect this replaces. Adding a third `reason` needs no change here: a new kind of claim
 *  gets its own key and inherits the right behaviour by construction. */
function dismissKey(rec: SwitchRecommendation): string {
  return `${rec.from.id}:${rec.reason}`;
}

/** One recorded wave-off. The first two fields come straight off the recommendation that was
 *  declined, so {@link retireStaleWallDismissals} never has to parse them back out of
 *  {@link dismissKey}'s string. */
interface DismissedClaim {
  accountId: string;
  reason: SwitchRecommendation["reason"];
  /** For a WALL wave-off, the `exhaustedUntil` of the EPISODE it declined — the episode's own
   *  identity, and the thing that makes retirement exact rather than dependent on tick timing. See
   *  {@link retireStaleWallDismissals}. `null` when no usage row for that account had been observed
   *  at dismiss time, which falls the helper back to plain "is it walled now". Meaningless for an
   *  `"approaching"` claim, which declines an estimate rather than an episode. */
  episode: number | null;
}

/** Drop each recorded WALL wave-off once the wall it declined is over.
 *
 *  THE TWO WAVE-OFFS HAVE DIFFERENT LIFETIMES because they decline different KINDS of statement:
 *
 *   - `"approaching"` is a standing preference — "stop nagging me about this account's estimate."
 *     Nothing makes that stop being what the user meant, so it survives the session, by design.
 *   - `"exhausted"` is about ONE episode — "I know acct-a is walled right now." An episode ends.
 *     Keeping it forever means the account walls AGAIN after its window resets, phase 1 finds the
 *     old key, and says nothing — the same fleet-parked-behind-a-live-wall silence the fall-through
 *     banner exists to prevent, displaced by one window. The user declined the 09:00 wall; nobody
 *     asked them about the 19:00 one.
 *
 *  IT JUDGES ON `exhaustedUntil`, NOT ON WHETHER THIS TICK PRODUCED A RECOMMENDATION, and the
 *  difference is the whole correctness of the thing. "No recommendation this tick" looks like a
 *  proxy for "the wall is over" and is not one: `switchRecommendation` also returns null when there
 *  is simply nowhere to go — `candidates` is empty because every other account is itself exhausted
 *  **or merely `warn`** — and when `busiestPaneAccount()` momentarily names someone else. On that
 *  proxy a wave-off gets retired mid-episode, and because a rival account's 5h fraction flaps across
 *  `WARN_FRACTION` on a 120s poll it retires repeatedly, re-raising a banner the user already
 *  declined for the whole ~5h wall. That is the "dismiss button that visibly does nothing" defect
 *  the reason-keying fixed, walking back in through a different door.
 *
 *  `exhaustedUntil` is the observable truth the wave-off was about: it can never expire mid-episode,
 *  and a later wall writes a NEW one, so the next episode is a new claim by construction. Same
 *  authority `assessHeadroom` uses for `state: "exhausted"`, so the two cannot disagree.
 *
 *  SO IT COMPARES THE EPISODE, NOT JUST "IS IT WALLED NOW" — and that is a stronger claim than it
 *  looks. Plain set membership can only tell two episodes apart if some evaluation happens to land
 *  in the GAP between them, and nothing guarantees one does. The poll is 120s, and the caller
 *  returns early while a switch plan is outstanding, so retirement does not run at all for as long
 *  as that plan lives — which one agent stuck `working` can stretch to hours. Let acct-a's window
 *  reset and re-wall anywhere inside that blind stretch and every tick that runs sees acct-a walled,
 *  keeps the stale wave-off, and silences a wall nobody declined. Comparing the recorded
 *  `exhaustedUntil` against the live one is exact no matter which ticks ran, so the "new episode is
 *  a new claim by construction" guarantee above is now true by construction rather than by luck.
 *
 *  A claim with no recorded episode (`null` — nothing was known about that account at dismiss time)
 *  falls back to the membership test, which is the weaker rule but never the wrong-way one.
 *
 *  BUT `exhaustedUntil` IS NOT IMMUTABLE WITHIN AN EPISODE, so "it changed" is not "a new wall".
 *  `pendingExhaustions` EXTENDS a live bench in place when a fresh limit lands — "a fresh limit
 *  after a partial recovery extends it" — polls at 60s (faster than this hook), and fans the same
 *  extension across sibling accounts. A continuously walled account's value therefore moves from T1
 *  to T2 without the wall ever ending, and reading that as a new episode would re-raise a banner the
 *  user declined for a wall that never stopped: strictly worse than the membership rule, which could
 *  not see the change at all.
 *
 *  The discriminator is whether the DECLINED wall had already lapsed. A later value observed while
 *  the recorded episode is still in the future is that same wall extended, so the claim is re-stamped
 *  and kept. Only once the recorded episode has passed does a different live wall mean a genuinely
 *  new one. Anything else — notably a live wall ending EARLIER than the one recorded, which
 *  `pendingExhaustions` never writes — is treated as a new claim, erring toward speaking, per the
 *  trade named above.
 *
 *  An account absent from `usage` is treated as not walled. That is the honest reading — no usage
 *  row means no observed rate-limit event — and it errs toward speaking, which is the safe side
 *  here: a spurious re-raise costs a click, a spurious silence costs a fleet idle for five hours.
 *
 *  THAT READING IS ONLY HONEST FOR A READ THAT HAPPENED, which is why the caller will not run this
 *  at all on a tick with `state.failed`. A failed load resolves to `usage: []` rather than throwing,
 *  so "the bridge is broken" arrives here wearing the exact shape of "nobody is walled" — and on
 *  that shape the paragraph above would retire EVERY live wave-off at once. `accountSelection.ts`
 *  keeps `failed` for precisely this conflation; the guard is at the call site because that is where
 *  the flag lives, and the helper stays a pure function of the usage it is handed. */
function retireStaleWallDismissals(
  dismissed: Map<string, DismissedClaim>,
  usage: readonly Pick<Usage, "id" | "exhaustedUntil">[],
  now: number = Date.now(),
): void {
  // accountId -> the `exhaustedUntil` of the wall that is live RIGHT NOW. The value, not just
  // membership, is what identifies the episode.
  const walled = new Map<string, number>();
  for (const u of usage) {
    if (u.exhaustedUntil != null && u.exhaustedUntil > now) walled.set(u.id, u.exhaustedUntil);
  }
  for (const [key, claim] of [...dismissed]) {
    if (claim.reason !== "exhausted") continue; // an estimate's wave-off is a standing preference
    const live = walled.get(claim.accountId);
    if (live === undefined) {
      dismissed.delete(key); // no live wall at all: the declined episode is over
    } else if (claim.episode === null || live === claim.episode) {
      // Nothing to compare, or the very episode that was declined. Either way it still stands.
    } else if (claim.episode > now && live > claim.episode) {
      // SAME wall, benched longer — not a new claim. Re-stamp so the comparison stays exact as the
      // bench keeps moving; without this the next extension would be measured against a stale value.
      claim.episode = live;
    } else {
      dismissed.delete(key); // the declined episode lapsed and another one is live: a new claim
    }
  }
}

/** The `switchTo` of the currently mounted hook, or null when none is mounted. It returns how many
 *  already-running agents the activation enrolled, which is what lets `activateAccount` distinguish
 *  "a host answered" from "something is actually moving". */
let liveSwitchTo: ((accountId: string) => number) | null = null;

/** Everything an activation must do that does NOT need a mounted hook: record the preference, and
 *  drop the pins a previous activation's migration wrote.
 *
 *  BOTH halves are durable, and that is why the sweep is here rather than only in `switchTo`. A pin
 *  outranks the preference (`chooseAccountForAgent` step 1), so an agent still carrying a pin from
 *  the LAST activation keeps spawning on the old account no matter what the preference says. Leaving
 *  the sweep on the hook's path made that permanent on the one path with no other remedy — no hook
 *  is mounted, so nothing arrives later to correct it — which is the same "an activation silently
 *  defeats the next one" defect the sweep exists to close. Idempotent, so the double call when a
 *  hook IS mounted costs nothing. */
function recordActivation(accountId: string): void {
  setPreferredAccountId(accountId);
  clearSwitchWrittenPins();
}

/** Activate `accountId` from outside React (the accounts modal's "Activate this account").
 *
 *  Returns whether ANY ALREADY-RUNNING AGENT WAS ENROLLED IN A MIGRATION — not whether a hook
 *  happened to be mounted. The distinction is the whole value of the return: `AccountSwitchHost` is
 *  mounted unconditionally inside `AuthGate`, so "a hook answered" is true in essentially every real
 *  app and would be a constant dressed up as a signal. `switchTo` returns after the durable half
 *  whenever the plan comes back empty — every pane already on the target, all remaining panes
 *  pinned or sticky, or no panes mounted — and in each of those cases nothing is moving. A caller
 *  that reads a mounted host as "the fleet is migrating" tells the human waiting out a rate limit
 *  the one thing that is not happening.
 *
 *  Everything durable happens either way (see `recordActivation`) — it must not depend on whether a
 *  particular component is in the tree. An agent that is not moved now still lands on the activated
 *  account at its next spawn, so a `false` is a slower path to the same place, never a failure. */
export function activateAccount(accountId: string): boolean {
  recordActivation(accountId);
  if (!liveSwitchTo) return false;
  return liveSwitchTo(accountId) > 0;
}
