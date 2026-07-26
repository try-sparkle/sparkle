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
import { loadAccountState, invalidateAccountState } from "../services/accountSelection";
import { listCeilings } from "../services/accountStore";
import { switchRecommendation, type SwitchRecommendation, type Ceiling } from "../services/headroom";
import { advanceSwitch, planSwitch, type SwitchPlan } from "../services/accountSwitch";
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
}

export function useAccountSwitch(pollMs: number = HEADROOM_POLL_MS): AccountSwitchState {
  const [recommendation, setRecommendation] = useState<SwitchRecommendation | null>(null);
  const [plan, setPlan] = useState<SwitchPlan | null>(null);
  // Accounts the user has waved off. Keyed by account id so a fresh recommendation about a
  // DIFFERENT account still shows, but the dismissed one stays quiet.
  const dismissed = useRef<Set<string>>(new Set());
  // Mirrors `plan` for the recommend loop, which must read the CURRENT value without re-subscribing
  // its interval every time the plan advances. Synced in an effect, not during render.
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
  useEffect(() => {
    if (!plan) return;
    const id = setInterval(() => {
      const statuses = useRuntimeStore.getState().status;
      setPlan((cur) => {
        if (!cur) return cur;
        const { plan: next, movedNow } = advanceSwitch(cur, statuses, restartPane);
        if (movedNow.length > 0) invalidateAccountState();
        // Retire the plan once everyone has moved, which also re-arms recommendations.
        return next.pending.length === 0 ? null : next;
      });
    }, SWITCH_ADVANCE_MS);
    return () => clearInterval(id);
  }, [plan]);

  const accept = useCallback(() => {
    if (!recommendation) return;
    const fresh = planSwitch(recommendation.from.id, recommendation.to.id, paneAccountMap());
    setRecommendation(null);
    // Nothing running on that account: just record the preference so future spawns land correctly,
    // rather than leaving an empty plan spinning.
    if (fresh.pending.length === 0) return;
    setPlan(fresh);
  }, [recommendation]);

  const dismiss = useCallback(() => {
    if (recommendation) dismissed.current.add(recommendation.from.id);
    setRecommendation(null);
  }, [recommendation]);

  return { recommendation, plan, accept, dismiss };
}
