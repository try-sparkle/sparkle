// Keeps account exhaustion flags in sync with REAL rate-limit events, app-wide.
//
// This is the live half of the failover loop. Phase 1 detected limits per-terminal by scraping PTY
// text, which meant (a) any agent printing the words benched an account and (b) the genuine message
// was never matched. Detection now polls Rust for structured `error: "rate_limit"` transcript
// records; this hook owns the timer and applies the results.
//
// It runs ONCE for the whole app rather than per agent pane: a limit belongs to an ACCOUNT, not to
// a pane, and every pane polling independently would multiply the transcript walk by the number of
// open agents to reach the same conclusion.
import { useEffect } from "react";
import { loadAccountState, invalidateAccountState } from "../services/accountSelection";
import { syncLimitsOnce, LIMIT_POLL_MS } from "../services/limitSync";

/** Poll for real rate-limit events and bench the affected accounts until their true reset time.
 *  Best-effort throughout — a failure is logged by `syncLimitsOnce` and retried on the next tick,
 *  never surfaced as an app error. */
export function useLimitSync(pollMs: number = LIMIT_POLL_MS): void {
  useEffect(() => {
    let cancelled = false;

    // Guard against overlapping ticks: on a large transcript tree a walk can outlast the interval,
    // and stacking them would multiply the work to reach the same answer.
    let running = false;
    const tick = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        await runTick();
      } finally {
        running = false;
      }
    };

    const runTick = async () => {
      const { usage, accounts, identities } = await loadAccountState();
      if (cancelled) return;
      // accounts + identities let a limit fan out across every registration of the SAME login —
      // they share one quota, so benching only the dir that logged the event leaves its twin
      // looking healthy and winning auto-pick.
      const applied = await syncLimitsOnce(usage, Date.now(), accounts, identities);
      // Only bust the cache when something actually changed, so the common (unlimited) case costs
      // one transcript walk and nothing else.
      if (!cancelled && applied.length > 0) invalidateAccountState();
    };

    void tick(); // check immediately on mount — a limit hit while the app was closed still applies
    const id = setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);
}
