// Live cross-project priority feed for the Concierge column (bead sparkle-ld0t, CM-U3).
//
// Thin subscription shell over the pure buildConciergeFeed (services/conciergeFeed.ts): subscribes
// to the live stores (projects, status, stage inputs, interaction times, mute rules) plus the Rust
// tray aggregator's merged fleet — the cross-window completeness source, since this window's
// runtimeStore.status only covers agents it hosts — and memoizes one ConciergeFeed for the
// concierge column + brain to render and reason over.
//
// The jump action is selectAndOpen (re-exported below, NOT reimplemented) — the same "reveal the
// agent wherever it is" path a notification click takes.
import { useEffect, useMemo, useState } from "react";
import { getTrayRoster, onTrayRosterChanged } from "./services/attention";
import { safeUnlisten } from "./services/safeUnlisten";
import { buildConciergeFeed, type ConciergeFeed } from "./services/conciergeFeed";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useInteractionStore } from "./stores/interactionStore";
import { useSparklePrefsStore } from "./stores/sparklePrefsStore";
import type { TrayRoster } from "./tray/trayRoster";

export { selectAndOpen } from "./useAttentionNotifications";
export {
  buildConciergeFeed,
  conciergePriority,
  conciergeTopics,
  type ConciergeFeed,
  type ConciergeProject,
  type ConciergeAgent,
  type ConciergeAgentPriority,
  type ConciergeCounts,
} from "./services/conciergeFeed";

export interface UseConciergeFeedOpts {
  /** Scope the concierge to one project (the pinned tab); omit/null to follow all projects. */
  pinnedProjectId?: string | null;
}

/** The live, memoized ConciergeFeed. Recomputes when projects, statuses, stage inputs,
 *  interaction times, mute rules, the tray's merged fleet, or the pin change. */
export function useConciergeFeed(opts?: UseConciergeFeedOpts): ConciergeFeed {
  const pinnedProjectId = opts?.pinnedProjectId ?? null;
  const projects = useProjectStore((s) => s.projects);
  const status = useRuntimeStore((s) => s.status);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const interaction = useInteractionStore((s) => s.lastAt);

  // The store's shouldInterrupt is a STABLE function reference, so subscribing to it alone would
  // never re-render when a rule is added/cleared. Subscribe to the rules map and rebuild the gate
  // from it; the gate reads live state at call time so clock-based expiry is honored either way.
  const rules = useSparklePrefsStore((s) => s.rules);
  const shouldInterrupt = useMemo(() => {
    void rules; // the gate's real input — recompute (and re-run the feed memo) when rules change
    return (topic: string) => useSparklePrefsStore.getState().shouldInterrupt(topic);
  }, [rules]);

  // The merged cross-window fleet: seed with a fetch, then follow the aggregator's pushes. Both
  // are no-ops outside Tauri (tests/SSR), leaving the roster null — the builder treats that as
  // "no cross-window data" and falls back to local status only.
  const [trayRoster, setTrayRoster] = useState<TrayRoster | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getTrayRoster().then((r) => {
      if (!cancelled && r) setTrayRoster(r);
    });
    const unlistenPromise = onTrayRosterChanged((r) => {
      if (!cancelled) setTrayRoster(r);
    });
    return () => {
      cancelled = true;
      void safeUnlisten(unlistenPromise);
    };
  }, []);

  return useMemo(
    () =>
      buildConciergeFeed({
        projects,
        status,
        workflowStage,
        branchStatus,
        openAgentIds,
        interaction,
        trayRoster,
        shouldInterrupt,
        pinnedProjectId,
      }),
    [
      projects,
      status,
      workflowStage,
      branchStatus,
      openAgentIds,
      interaction,
      trayRoster,
      shouldInterrupt,
      pinnedProjectId,
    ],
  );
}
