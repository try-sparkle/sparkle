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
import { useProjectStore } from "../stores/projectStore";
import { loadAccountState, invalidateAccountState } from "../services/accountSelection";
import { listCeilings } from "../services/accountStore";
import { switchRecommendation, type SwitchRecommendation, type Ceiling } from "../services/headroom";
import { advanceSwitch, buildSwitchAllPlan, planSwitch, type SwitchPlan } from "../services/accountSwitch";
import { busiestPaneAccount, paneAccountMap, restartPane } from "../services/paneControl";
import { subscribeSwitchAll } from "../services/manualAccountSwitch";

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
  /** MANUAL trigger: switch EVERY agent + the concierge to `accountId`, driven by the same
   *  advanceSwitch loop that carries out an accepted recommendation. See {@link buildSwitchAllPlan}. */
  switchAllTo: (accountId: string) => void;
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
    // Nothing running on that account: just record the preference so future spawns land correctly,
    // rather than leaving an empty plan spinning.
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

  // ---- MANUAL: switch EVERY agent + the concierge to one account ------------------------------
  //
  // A human clicked "switch all agents here". Unlike `accept`, this is NOT gated on a recommendation
  // and is DELIBERATELY not consulted against `dismissed` — the founder asking for it outright always
  // means it. It builds a plan over the WHOLE fleet (every agent across every project) and pins the
  // concierge, then hands the plan to the SAME phase-2 loop above; there is no second switch loop.
  const switchAllTo = useCallback((accountId: string) => {
    const projects = useProjectStore.getState().projects;
    // `buildSwitchAllPlan` also pins the concierge (setPin), so that happens even when the fleet has
    // no panes to enroll.
    const fresh = buildSwitchAllPlan(projects, accountId);
    // Clear any live recommendation — the manual action supersedes it, and suppressing the banner is
    // the honest thing while the switch runs.
    setRecommendation(null);
    // No agent panes to move: the concierge pin is already recorded above, so there is nothing to
    // drive. Leaving an empty plan spinning would just churn the advance loop.
    if (fresh.pending.length === 0) return;
    // Write the ref alongside the state — phase 2 reads the plan from the ref (see its note), so it
    // must be current the instant a plan exists rather than one commit later.
    planRef.current = fresh;
    setPlan(fresh);
  }, []);

  // The Accounts screen is a transient modal, so it cannot own the long-running switch. It fires a
  // request through `manualAccountSwitch`; this app-wide host receives it and drives the loop.
  useEffect(() => subscribeSwitchAll((accountId) => switchAllTo(accountId)), [switchAllTo]);

  return { recommendation, plan, accept, dismiss, switchAllTo };
}
