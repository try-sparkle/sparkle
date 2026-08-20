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
import { usePromptGraceTick } from "./hooks/useBlockedPromptGrace";
import { windowRetractionLedger } from "./engine/movementRetraction";
import { windowPromptGraceLedger } from "./engine/blockedPromptGrace";
import { getRoster, onRosterChanged } from "./services/attention";
import { safeUnlisten } from "./services/safeUnlisten";
import { buildConciergeFeed, type ConciergeFeed } from "./services/conciergeFeed";
import { useNudgeFlagSnapshot } from "./useNudgeFlags";
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
  // The captured ask screen + when it was captured — the two sibling maps the prompt-grace rule
  // hashes a prompt's identity from and measures its 30s ceiling against. Subscribed as a PAIR
  // because the store writes them as one (runtimeStore.attentionScreenAt), and a feed holding one
  // without the other would measure a hold from the wrong instant.
  // The nudger flag table, subscribed. It lives outside React (a module-level Map in
  // `services/authRecovery`), and `publishedStatusFor` reads it to decide whether a stated human
  // block survives the nudge-loop demotion. Without this the digest could never learn about a flag:
  // a flagged agent is SILENT, so none of the store maps below ever move again, and the feed would
  // keep reporting `lapsed` for a row the sidebar had already painted red (roborev 65408).
  const nudgeFlags = useNudgeFlagSnapshot();
  const attentionScreen = useRuntimeStore((s) => s.attentionScreen);
  const attentionScreenAt = useRuntimeStore((s) => s.attentionScreenAt);
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

  // WHICH DRAWN PROMPTS ARE BEING HELD — the same argument as `retraction` above, plus two reasons
  // of its own (see `engine/blockedPromptGrace.windowPromptGraceLedger`). The BURN SET is the only
  // record that a prompt was already hidden once, so losing it on an unmount re-arms the invisible
  // hide→re-raise→hide loop the never-twice rule exists to prevent. And the OUTCOMES are written
  // from services (`conciergeDispatch`, `suggestions/approvalsRuntime`) that hold no React context
  // at all, so a per-component ledger could not receive them even in principle.
  const promptGrace = windowPromptGraceLedger();

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
  const fleetAgents = useMemo(() => projects.flatMap((p) => p.agents), [projects]);
  const graceTick = useNewAgentGraceTick(fleetAgents, status, interaction);

  // …AND THE PROMPT HOLD IS A DEADLINE TOO, with a sharper edge. The 30s ceiling exists for exactly
  // the case where the answerer is wedged, crashed or was never invoked — and in every one of those
  // cases nothing further is emitted, so none of this memo's deps change again and the held prompt
  // would band CALM FOREVER while the founder never learns a question was asked. Same defect, same
  // fix; see hooks/useBlockedPromptGrace.
  const promptTick = usePromptGraceTick(fleetAgents, promptGrace, attentionScreen, attentionScreenAt, status);

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
        promptGrace,
        attentionScreen,
        attentionScreenAt,
        // The subscribed snapshot, READ here rather than merely listed in the deps below — a
        // listed-not-read token is enforced by nothing, since the eslint-disable suppresses the rule
        // in both directions (roborev 65448).
        //
        // ⚠️ BUT NOT COMPILER-ENFORCED, and the earlier claim that it was is wrong (roborev 65465):
        // `nudgeFlags` is OPTIONAL on `ConciergeFeedInput` (54 call sites make required pure churn)
        // and its default is the DEMOTING `new Map()`. What holds this line in place is the
        // after-mount test in `useConciergeFeed.test.tsx`, which goes red if it is deleted.
        nudgeFlags,
      }),
    // `graceTick` / `promptTick` are not referenced in the body BY DESIGN — they are the only inputs
    // that change when a grace window closes with nothing else happening in the app, which is the
    // whole point of them. Same pattern, and the same reason, as hooks/useNewAgentCalm's memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      projects,
      status,
      workflowStage,
      branchStatus,
      openAgentIds,
      lastObserved,
      agentMovement,
      attentionScreen,
      attentionScreenAt,
      interaction,
      roster,
      shouldInterrupt,
      pinnedProjectId,
      graceTick,
      promptTick,
      // READ in the body (passed to `buildConciergeFeed`), unlike the two ticks above. Held by the
      // after-mount test rather than by the compiler — see the note at the call site (roborev 65465).
      nudgeFlags,
    ],
  );
}
