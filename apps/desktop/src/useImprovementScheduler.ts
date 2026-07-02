// Mounts the hourly improvement-pass scheduler (bead sparkle-4xwk.2) — the clock behind the
// consent banner's "once per hour" promise. One instance per app: Workspace mounts it only in
// the MAIN window, so tray/secondary windows never race a duplicate scheduler. The tick is
// deliberately slow (IMPROVEMENT_TICK_MS) and every decision input is read fresh from the
// stores inside the tick, so consent changes take effect on the next tick without re-mounting.
import { useEffect } from "react";
import {
  IMPROVEMENT_TICK_MS,
  isPassRunning,
  runImprovementPass,
  shouldRunImprovementPass,
} from "./services/improvementPass";
import { SPARKLE_AGENT_ID } from "./services/sparkleAgent";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";

export function useImprovementScheduler(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const settings = useSettingsStore.getState();
      const consent = settings.sparkleImprovementConsent;
      if (consent === "never") return;
      // First-ever tick with consent active: seed the clock instead of running, so the first
      // pass lands ~an hour later rather than ambushing a fresh launch (see settingsStore).
      if (settings.improvementLastRunAt === null) {
        settings.setImprovementLastRunAt(Date.now());
        return;
      }
      const due = shouldRunImprovementPass({
        consent,
        lastRunAt: settings.improvementLastRunAt,
        now: Date.now(),
        passRunning: isPassRunning(),
        paneStatus: useRuntimeStore.getState().status[SPARKLE_AGENT_ID],
      });
      if (!due) return;
      // Stamp at ATTEMPT time (not completion) so a slow or failing pass still waits a full
      // hour before the next one — no hot-looping a broken setup.
      settings.setImprovementLastRunAt(Date.now());
      void runImprovementPass(consent);
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
