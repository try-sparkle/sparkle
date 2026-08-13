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
} from "../services/accountSelection";
import {
  listCeilings,
  setPreferredAccountId,
  clearSwitchWrittenPins,
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
  // Accounts the user has waved off. Keyed by account id so a fresh recommendation about a
  // DIFFERENT account still shows, but the dismissed one stays quiet.
  const dismissed = useRef<Set<string>>(new Set());
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
        const current = busiestPaneAccount();
        const rec = switchRecommendation(
          current,
          state.accounts,
          state.usage,
          ceilings,
          state.identities,
        );
        // Suppress while a switch is already running — the answer is "we're on it", not a new ask.
        if (planRef.current) return;

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

        setRecommendation(rec && !dismissed.current.has(rec.from.id) ? rec : null);
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
    if (recommendation) dismissed.current.add(recommendation.from.id);
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
