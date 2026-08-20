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
import { loadAccountState, invalidateAccountState, liveUsageRows } from "../services/accountSelection";
import { syncLimitsOnce, LIMIT_POLL_MS } from "../services/limitSync";
import { raiseFirstLimitUnlessAutoSwitchHandles } from "../stores/accountLimitStore";
import { listCeilings } from "../services/accountStore";
import { switchRecommendation, type Ceiling } from "../services/headroom";
import { planStrandedHelperRescue } from "../services/accountSwitch";
import { busiestPaneAccount, paneAccountMap } from "../services/paneControl";

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
      if (cancelled || applied.length === 0) return;
      invalidateAccountState();

      // A landed exhaustion is the deterministic "you are blocked" signal the founder asked for —
      // `syncLimitsOnce` returns only writes that PERSISTED, and re-seeing the same event is a
      // no-op, so this fires on a genuinely new (or extended) limit rather than on every tick.
      //
      // But it is the FALLBACK, not the first response: with auto-switch ON the founder expects the
      // fleet moved for him, not a "log in to another account" modal. So before raising it, ask the
      // SAME question `useAccountSwitch` asks — is there a healthy, signed-in, different-identity
      // account to migrate the walled fleet onto? `switchRecommendation` is that exact oracle, and a
      // non-null result means auto-switch will carry the migration out at a safe boundary. In that
      // case the modal is redundant and stealing focus, so we suppress it; only when there is
      // genuinely nowhere to go does the modal remain the last signal and show.
      //
      // Fresh state is re-loaded so the just-landed bench is reflected — an exhausted `from` is what
      // makes `switchRecommendation` evaluate a target at all — and the SAME cached live rows the
      // spawn gate uses are passed so a live-spent account is not counted as an escape.
      const fresh = await loadAccountState();
      if (cancelled) return;
      let ceilings: Ceiling[] = [];
      try {
        ceilings = await listCeilings();
      } catch {
        // No ceilings → accounts read "unknown", never healthy-by-estimate. The observed-wall
        // recommendation does not need them; a failure here just leaves us raising the modal.
      }
      if (cancelled) return;
      const now = Date.now();
      const live = liveUsageRows();
      const rec = switchRecommendation(
        busiestPaneAccount(),
        fresh.accounts,
        fresh.usage,
        ceilings,
        fresh.identities,
        now,
        live,
      );
      // A helper stranded on its OWN exhausted account is rescued by `useAccountSwitch` even when it
      // is not the busiest account — so the modal for it would ask the founder to do by hand what the
      // automation is already doing. Suppress it on the SAME oracle the rescue acts on. Without this
      // the busiest-account `rec` is null (that account is healthy) and the modal fires anyway.
      const helperRescue =
        planStrandedHelperRescue(
          fresh.accounts,
          fresh.usage,
          ceilings,
          fresh.identities,
          now,
          live,
          paneAccountMap(),
        ) !== null;
      raiseFirstLimitUnlessAutoSwitchHandles(applied, rec !== null || helperRescue);
    };

    void tick(); // check immediately on mount — a limit hit while the app was closed still applies
    const id = setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);
}
