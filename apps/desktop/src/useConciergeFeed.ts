// Live cross-project status-band feed for the Concierge column (bead sparkle-ld0t, CM-U3).
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
import { useNewAgentGraceTick } from "./hooks/useNewAgentCalm";
import { windowRetractionLedger } from "./engine/movementRetraction";
import { getRoster, onRosterChanged } from "./services/attention";
import { safeUnlisten } from "./services/safeUnlisten";
import { buildConciergeFeed, type ConciergeFeed } from "./services/conciergeFeed";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useInteractionStore } from "./stores/interactionStore";
import { useSparklePrefsStore } from "./stores/sparklePrefsStore";
import type { Roster } from "./services/rosterTypes";

export { selectAndOpen } from "./useAttentionNotifications";
export {
  buildConciergeFeed,
  conciergeBand,
  conciergeTopics,
  emptyCounts,
  isCalmBand,
  type ConciergeFeed,
  type ConciergeProject,
  type ConciergeAgent,
  type ConciergeCounts,
} from "./services/conciergeFeed";
export type { StatusBand } from "./engine/buildSections";

export interface UseConciergeFeedOpts {
  /** Scope the concierge to one project (the pinned tab); omit/null to follow all projects. */
  pinnedProjectId?: string | null;
}

/** The live, memoized ConciergeFeed. Recomputes when projects, statuses, stage inputs,
 *  interaction times, mute rules, the merged cross-window fleet, or the pin change. */
export function useConciergeFeed(opts?: UseConciergeFeedOpts): ConciergeFeed {
  const pinnedProjectId = opts?.pinnedProjectId ?? null;
  const projects = useProjectStore((s) => s.projects);
  const status = useRuntimeStore((s) => s.status);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const lastObserved = useRuntimeStore((s) => s.lastObserved);
  const agentMovement = useRuntimeStore((s) => s.agentMovement);
  const interaction = useInteractionStore((s) => s.lastAt);

  // WHEN EACH RED BEGAN — the other half of `engine/movementRetraction` (bead sparkle-7ba9e).
  //
  // NOT state: recording an epoch must never itself cause a render (it would loop — the render is
  // what records it), and it is read inside the memo rather than rendered.
  //
  // AND NOT A `useRef` EITHER, which is what this was first written as. A per-instance ledger dies
  // with the component, and it is the ONLY record of when a red began: this hook has two live
  // callers with different lifetimes — `Workspace` (inside ReadinessGate/AuthGate/Suspense, so it
  // unmounts) and `useHelperVitalsPublisher` (App.tsx, never unmounts) — so a ref both LOSES the
  // epochs on a remount, re-stamping every frozen red with a time no earlier movement can beat, and
  // gives the island and the column two different answers about the same agent. See
  // `windowRetractionLedger` for the full argument.
  //
  // FILLED BY THE BUILDER, not here, and that is deliberate. The epoch has to be stamped from the
  // MERGED status — local plus the cross-window roster — because the reds that freeze are precisely
  // the ones this window does not host, and those arrive via the roster. That merge happens inside
  // `buildConciergeFeed`, so the ledger is threaded in as an out-param and stamped there, exactly as
  // `rolledUpGreen` already is. Stamping it here off local `status` alone would leave every unhosted
  // red with no epoch — and a red with no epoch is never retracted, which is the whole bug.
  const retraction = windowRetractionLedger();

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
  const [roster, setRoster] = useState<Roster | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getRoster().then((r) => {
      if (!cancelled && r) setRoster(r);
    });
    const unlistenPromise = onRosterChanged((r) => {
      if (!cancelled) setRoster(r);
    });
    return () => {
      cancelled = true;
      void safeUnlisten(unlistenPromise);
    };
  }, []);

  // The `new` grace window is a DEADLINE, and none of this memo's deps change again for a held
  // `errored` agent — so without a tick the concierge column would band it calm forever while
  // `get_agent_status` (clock-per-call) reported errored/needsYou. Same defect, same fix, as the
  // three surfaces in hooks/useNewAgentCalm (roborev 54830).
  const graceTick = useNewAgentGraceTick(
    useMemo(() => projects.flatMap((p) => p.agents), [projects]),
    status,
    interaction,
  );

  return useMemo(
    () =>
      buildConciergeFeed({
        projects,
        status,
        workflowStage,
        branchStatus,
        openAgentIds,
        lastObserved,
        interaction,
        roster,
        shouldInterrupt,
        pinnedProjectId,
        agentMovement,
        retraction,
      }),
    // `graceTick` is not referenced in the body BY DESIGN — it is the only input that changes when a
    // grace window closes with nothing else happening in the app, which is the whole point of it.
    // Same pattern, and the same reason, as hooks/useNewAgentCalm's memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      projects,
      status,
      workflowStage,
      branchStatus,
      openAgentIds,
      lastObserved,
      agentMovement,
      interaction,
      roster,
      shouldInterrupt,
      pinnedProjectId,
      graceTick,
    ],
  );
}
