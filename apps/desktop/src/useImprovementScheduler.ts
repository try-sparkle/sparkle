// Mounts the hourly improvement-pass scheduler (bead sparkle-4xwk.2) — the clock behind the
// consent banner's "once per hour" promise. One instance per app: Workspace mounts it only in
// the MAIN window, so tray/secondary windows never race a duplicate scheduler. The tick is
// deliberately slow (IMPROVEMENT_TICK_MS) and every decision input is read fresh from the
// stores inside the tick, so consent changes take effect on the next tick without re-mounting.
import { useEffect } from "react";
import {
  hourlySlotStamp,
  IMPROVEMENT_TICK_MS,
  isHourlySlotDue,
  isPassRunning,
  notePaneStatus,
  passRetryDueAt,
  runImprovementPass,
  shouldRunImprovementPass,
} from "./services/improvementPass";
import { SPARKLE_AGENT_ID } from "./services/sparkleAgent";
import { useConnectionStore } from "./stores/connectionStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";

export function useImprovementScheduler(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const settings = useSettingsStore.getState();
      // Sample the pane BEFORE any early return: this tick is the only regular observer of the
      // pane's status, and a latch that only advanced on ticks that got as far as the gate would
      // never age past the first hold — which is the one measurement the wedge bound needs.
      const paneStatus = useRuntimeStore.getState().status[SPARKLE_AGENT_ID];
      const paneBusySince = notePaneStatus(paneStatus, Date.now());
      const consent = settings.sparkleImprovementConsent;
      if (consent === "never") return;
      // First-ever tick with consent active: seed the clock instead of running, so the first
      // pass lands ~an hour later rather than ambushing a fresh launch (see settingsStore).
      if (settings.improvementLastRunAt === null) {
        settings.setImprovementLastRunAt(Date.now());
        return;
      }
      const now = Date.now();
      const due = shouldRunImprovementPass({
        consent,
        lastRunAt: settings.improvementLastRunAt,
        now,
        passRunning: isPassRunning(),
        paneStatus,
        paneBusySince,
        // A pass that died because the network was unreachable never ran; it gets ONE early
        // re-attempt instead of forfeiting the slot (improvementPass.ts owns the latch).
        retryDueAt: passRetryDueAt(),
        // Read fresh inside the tick, like every other input: a slot that comes due while the
        // machine is offline waits for the network instead of burning itself on a launch that
        // cannot reach the API.
        isOnline: useConnectionStore.getState().isOnline,
      });
      if (!due) return;
      // Which kind of run this is, read BEFORE the stamp below overwrites the clock: the hourly
      // slot coming due (re-earns the one retry) or the early re-attempt (spends it).
      const freshSlot = isHourlySlotDue(settings.improvementLastRunAt, now);
      // Stamp at ATTEMPT time (not completion) so a slow or failing pass still waits a full
      // hour before the next one — no hot-looping a broken setup. Same `now` the gate weighed,
      // so the reading above and the stamp can't straddle a clock tick.
      //
      // The stamp is the slot BOUNDARY, not this tick: ticks are always a little late (and a lot
      // late when the window is backgrounded and timers throttle), and recording the tick time
      // folds that lateness into the phase forever. See `hourlySlotStamp` for the measurement.
      settings.setImprovementLastRunAt(hourlySlotStamp(settings.improvementLastRunAt, now));
      void runImprovementPass(consent, freshSlot);
    };
    // A short first check (not immediate — let startup I/O settle), then the slow tick.
    const first = setTimeout(tick, 15_000);
    const id = setInterval(tick, IMPROVEMENT_TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [enabled]);
}
