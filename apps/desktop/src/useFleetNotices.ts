// THE BINDING — the one piece that was missing, reported three times from three layers.
//
// `pusherFleet` decides what is measurably wrong across the fleet; `pusherSnapshots` maps app state
// into the shape it wants. Neither had a production caller, so every condition was computed in tests
// and delivered nowhere. This is the caller: a thin subscription shell that reads the live stores
// and the engine registry, and hands back the conditions for a surface to render.
//
// ── WHY A HOOK AND NOT THE SWEEP ─────────────────────────────────────────────────────────────────
// `pusherRunner` exists to SEND — it owns the message budget, the cooldowns and the two-observation
// rule, because an interruption has to be rationed. A rendered card is not an interruption: it costs
// nothing, it is only seen when someone looks, and it self-heals when the condition clears. So the
// display path needs none of that machinery and deliberately skips it, exactly as `ConciergeHost`
// renders nudge cards straight from the feed rather than through a sender.
//
// That is also why this is the path that works during the events it reports. Rendering needs no
// model and no network: a quota-blocked fleet or a host that just restarted still paints this card,
// which is the whole reason the founder's report route had to be feed-derived rather than a
// concierge turn (a `claude -p` call dies in the same outage — `apiRecovery`'s header settled that).
//
// ── EVERY READ IS FAIL-CLOSED ────────────────────────────────────────────────────────────────────
// The registry lookups return `undefined` for an agent this window never mounted, and
// `branchStatus` is missing for any agent whose poll has not run. `pusherSnapshots` maps all of that
// to absent fields, and `pusherFleet` treats absent as NOT LOOKED rather than as an answer. Nothing
// here manufactures a reading to fill a gap.

import { useMemo } from "react";
import { evaluateFleetConditions, type FleetCondition } from "@sparkle/core";
import { buildFleetSnapshots, buildStandingDuties, PASS_HOLD_TEXT } from "./services/pusherSnapshots";
import {
  IMPROVEMENT_INTERVAL_MS,
  isPassRunning,
  passHoldReason,
  passRetryDueAt,
} from "./services/improvementPass";
import { lastFailureForAgent, quotaBlockForAgent } from "./engine/engineRegistry";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useConnectionStore } from "./stores/connectionStore";
import { SPARKLE_AGENT_ID } from "./services/sparkleAgent";

/** Everything the conditions are computed from, gathered from the live stores. */
export interface FleetNoticeInputs {
  projects: ReturnType<typeof useProjectStore.getState>["projects"];
  branchStatus: ReturnType<typeof useRuntimeStore.getState>["branchStatus"];
  improvementLastRunAt: number | null;
  /** The hold reason as a quotable sentence, or undefined when nothing is holding the pass. */
  improvementHeldBy: string | undefined;
  now: number;
}

/**
 * The conditions, from already-gathered inputs. Pure, so the whole binding is testable without a
 * running app — the store reads live in the hook below and are three lines.
 */
export function fleetNoticesFrom(input: FleetNoticeInputs): FleetCondition[] {
  const snapshots = buildFleetSnapshots({
    projects: input.projects,
    branchStatus: input.branchStatus,
    quotaFor: quotaBlockForAgent,
    failureFor: lastFailureForAgent,
    now: input.now,
  });
  const duties = buildStandingDuties({
    improvementLastRunAt: input.improvementLastRunAt,
    improvementIntervalMs: IMPROVEMENT_INTERVAL_MS,
    ...(input.improvementHeldBy !== undefined ? { improvementHeldBy: input.improvementHeldBy } : {}),
  });
  return evaluateFleetConditions(snapshots, input.now, duties);
}

/**
 * Why the hourly pass is not running right now, as a sentence, or `undefined` when nothing holds it.
 *
 * Reads the SAME gate the scheduler does rather than a second copy — `passHoldReason` is the one
 * decision, and `shouldRunImprovementPass` delegates to it, so the card can never explain a hold
 * that is not the one in force.
 */
export function improvementHoldText(now: number): string | undefined {
  const settings = useSettingsStore.getState();
  const reason = passHoldReason({
    consent: settings.sparkleImprovementConsent,
    lastRunAt: settings.improvementLastRunAt,
    now,
    passRunning: isPassRunning(),
    paneStatus: useRuntimeStore.getState().status[SPARKLE_AGENT_ID],
    retryDueAt: passRetryDueAt(),
    isOnline: useConnectionStore.getState().isOnline,
  });
  return reason === null ? undefined : PASS_HOLD_TEXT[reason];
}

/**
 * The live fleet conditions for this window.
 *
 * `now` is a PARAMETER rather than a `Date.now()` inside the memo, because two of the conditions are
 * duration-based (`duty-overdue`, and the age a shared failure quotes) and a memo that re-read the
 * clock only when its store deps changed would freeze those numbers on a quiet fleet — the card
 * would say "9h overdue" for as long as nothing else moved. Callers pass a ticking clock.
 */
export function useFleetNotices(now: number): FleetCondition[] {
  const projects = useProjectStore((s) => s.projects);
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const improvementLastRunAt = useSettingsStore((s) => s.improvementLastRunAt);

  return useMemo(
    () =>
      fleetNoticesFrom({
        projects,
        branchStatus,
        improvementLastRunAt,
        improvementHeldBy: improvementHoldText(now),
        now,
      }),
    [projects, branchStatus, improvementLastRunAt, now],
  );
}
