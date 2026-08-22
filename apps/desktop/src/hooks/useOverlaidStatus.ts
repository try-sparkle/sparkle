// THE PRE-ESCALATION STATUS MAP, BUILT ONCE — the input every surface that asks a stall question
// has to share, or those surfaces answer differently about the same agent.
//
// ══ WHY THIS EXISTS ════════════════════════════════════════════════════════════════════════════
// `AgentSidebar` built this chain inline, which was correct while it was the only caller. The Epics
// column now asks the same question (an epic's square is rolled up from its bound build agents,
// bead `sparkle-l06ax7`) and its first cut passed `withUnmergedWork(agents, RAW status, …)` — the
// tail of the chain with none of the overlays. That is not a cosmetic difference: `stallReport`
// gates its arms behind `isQuiet(status)`, so a head carrying a red worker reads `blocked` here
// (verdict `active`, NOT finished) and raw `idle` there (verdict `finished`). The two columns then
// disagree about the same head in exactly the case the shared reading was extracted to fix.
//
// So the map is derived in ONE place and handed out, rather than described in a doc comment and
// rebuilt by each caller. A parameter cannot enforce "and derive it the same way I did"; a hook can.
//
// ══ ORDER IS LOAD-BEARING AT EVERY STEP, AND EACH ONE IS SOMEONE'S POST-MORTEM ═════════════════
// Kept verbatim from `AgentSidebar`, including the reasons, because "keeping the two calls at the
// same position is the only thing that holds them equal" to `publishedStatusFor`'s chain — and
// `publishedRollupAgreement.test.ts` is structurally blind to this parallel copy, since both maps
// it compares come out of the one `composeRollup`.
import { useMemo } from "react";
import { withObservedAttention } from "../engine/observedAttention";
import {
  withRedWorkerAttention,
  withUnstartedWorkerAttention,
} from "../engine/workerAttention";
import { withUnmergedWork } from "../engine/unmergedAttention";
import { withBackgroundTaskGreen } from "../engine/workerRollup";
import { hasLiveBackgroundTasksForAgent } from "../services/backgroundTaskRegistry";
import { resolveStage } from "../engine/workflowStage";
import { useNewAgentCalm, useNewAgentGraceTick } from "./useNewAgentCalm";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useInteractionStore } from "../stores/interactionStore";
import type { AgentTab, AgentTabStatus } from "../types";

export interface OverlaidStatus {
  /** The overlaid map: observed-attention correction, new-agent calm, then the two worker-attention
   *  bubbles. This is what a ROW's colour and the sort order read. */
  status: Record<string, AgentTabStatus>;
  /** {@link status} with `withUnmergedWork` applied — the PRE-ESCALATION map. The stall question is
   *  asked about this one: `stallReport` answers `active` for the red tier, so feeding it the
   *  ESCALATED map would collapse every report to "nothing outstanding" and the escalation would
   *  erase its own justification. */
  calmStatus: Record<string, AgentTabStatus>;
  /** The new-agent grace wake-up, exposed as a VALUE so a memo further down can depend on it.
   *
   *  It is not decoration and it is not derivable from anything else in a dep list: the composition
   *  downstream samples its own clock, and for a held `errored` or briefless agent NO other input
   *  ever changes again — so without this a row's disc and its filter chip sit on the pre-deadline
   *  reading forever while another surface has already reddened (roborev 54830). Any consumer that
   *  memoizes over this map must list it. */
  graceTick: number;
}

/**
 * Build the overlaid and pre-escalation status maps for one project's agents.
 *
 * Pass an EMPTY array for a pair with no project; every step is a no-op over it, so a caller does
 * not need a null branch. Use a STABLE empty array — a fresh `[]` per render re-runs every memo here.
 */
export function useOverlaidStatus(
  agents: readonly AgentTab[],
  /** Injected for the same reason `composeRollup` injects it — a module-state read is not something
   *  a test can drive. Production callers pass nothing and get the real window-local registry. */
  hasBackgroundTasksOf: (id: string) => boolean = hasLiveBackgroundTasksForAgent,
): OverlaidStatus {
  const liveStatus = useRuntimeStore((s) => s.status);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const lastObserved = useRuntimeStore((s) => s.lastObserved);
  const observedAttention = useRuntimeStore((s) => s.observedAttention);
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const interactionAt = useInteractionStore((s) => s.lastAt);
  const openIds = useMemo(() => new Set(openAgentIds), [openAgentIds]);

  const observedCorrected = useMemo(
    () => withObservedAttention(agents, liveStatus, observedAttention, (id) => openIds.has(id)),
    [agents, liveStatus, observedAttention, openIds],
  );
  // (0) BEFORE THE BUBBLES: a spawned-but-never-briefed agent reads `new` (GRAY) rather than the red
  // `blocked` statusEngine's 25s stall timer hands it for being quiet. Once a red has bubbled to an
  // orchestrator it is indistinguishable from that row's own, so this step cannot run after them.
  const s0 = useNewAgentCalm(agents, observedCorrected, interactionAt);
  const graceTick = useNewAgentGraceTick(agents, liveStatus, interactionAt);

  // (0c) GREEN WHILE DELEGATING — an agent whose own turn CLOSED while its subagents run on.
  //
  // ⚠️ THIS STEP WAS MISSING HERE, AND THAT ABSENCE *WAS* THE FOUNDER'S BUG. `composeRollup` has
  // applied it at this exact position since bead sparkle-262p7; this parallel copy never did. The
  // consequence is not a subtle band difference, it is the row's COLOUR: `AgentSidebar` paints the
  // Improve Sparkle disc from `effectiveStatus[sparkleAgentId]`, which descends from THIS chain, and
  // lets the rollup override it only when the two BANDS disagree. Promote in `composeRollup` alone
  // and both sides read `running`, so nothing overrides — and the disc keeps painting the `idle` this
  // chain still holds. GRAY, with N subagents live. That is the screenshot.
  //
  // The file header says keeping the two chains at the same position "is the only thing that holds
  // them equal", and `publishedRollupAgreement.test.ts` is structurally blind to this copy. So the
  // guard for this one is `delegatedGreenParity.test.tsx`, which drives BOTH chains and asserts they
  // agree — for a build row and for the self row.
  //
  // STALENESS, stated rather than hidden: `hasBackgroundTasksOf` reads a module-level registry, not a
  // store, so this memo cannot re-run merely because the count changed. It re-runs when `liveStatus`
  // moves, which is the same coupling `composeRollup` relies on — and Claude Code auto-resumes a
  // follow-up turn when a background task finishes, which moves it. Injected as a parameter for the
  // same reason `composeRollup` injects it: so a test can drive the rule without the live registry.
  const s0c = useMemo(
    () => withBackgroundTaskGreen(agents, s0, hasBackgroundTasksOf),
    [agents, s0, hasBackgroundTasksOf],
  );

  const status = useMemo(() => {
    // Two attention overlays, composed: (1) an unstarted worker gets a synthetic red + bubbles to
    // its orchestrator; (2) a started-then-red worker — ANY red-tier status, `blocked` included —
    // bubbles its own red up. Order matters: run (2) after (1) so a strand's synthetic red bubbles
    // too. `lastObserved` (sparkle-w340) lets (1) tell a closed pane from a never-started strand.
    const s1 = withUnstartedWorkerAttention(agents, s0c, openIds, lastObserved);
    return withRedWorkerAttention(agents, s1);
  }, [agents, openIds, s0c, lastObserved]);

  const calmStatus = useMemo(
    () => withUnmergedWork(agents, status, (id) => resolveStage(branchStatus[id], workflowStage[id])),
    [agents, status, branchStatus, workflowStage],
  );

  return { status, calmStatus, graceTick };
}
