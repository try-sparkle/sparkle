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
import { useEffect, useMemo, useState } from "react";
import { withObservedAttention } from "../engine/observedAttention";
import {
  withRedWorkerAttention,
  withUnstartedWorkerAttention,
} from "../engine/workerAttention";
import { withUnmergedWork } from "../engine/unmergedAttention";
import { withDeadSessionCalm } from "../engine/deadSessionAttention";
import { withLandedRedVeto } from "../engine/landedRedVeto";
import { withBackgroundTaskGreen } from "../engine/workerRollup";
import { hasLiveBackgroundTasksForAgent } from "../services/backgroundTaskRegistry";
import { deathCauseForAgent } from "../services/deadSessionRegistry";
import type { DeathCause } from "../engine/deathTypes";
import { resolveStage } from "../engine/workflowStage";
import { useNewAgentCalm, useNewAgentGraceTick } from "./useNewAgentCalm";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useInteractionStore } from "../stores/interactionStore";
import type { AgentTab, AgentTabStatus } from "../types";

/**
 * THE RUNGS OF THE DEAD-SESSION WAKE-UP, in ms after the status map last moved.
 *
 * Sized against the ONE thing this ladder exists to outlive: the `await invoke("agent_life_close")`
 * that sits between `statusEngine.exit()`'s terminal status write and `noteAgentDeath` — a single
 * Tauri IPC round trip. The first rung catches the ordinary case; the last is the headroom for an
 * IPC queued behind a busy backend, since the alternative to arriving late is not arriving at all.
 *
 * FINITE ON PURPOSE. An unbounded interval here would be a permanent re-render heartbeat under the
 * whole sidebar, paid forever by every user, to observe an event that happens seconds after a status
 * change or not at all. Three rungs cover ~10s from the last status write and then the ladder
 * disarms — a quiet app holds no timer.
 */
const DEAD_SESSION_WAKE_RUNGS_MS = [400, 2_000, 8_000] as const;

/**
 * A counter that increments a BOUNDED number of times after `statusMap` last changed identity.
 *
 * The dead-session overlay's input is a module-level registry (`services/deadSessionRegistry`), and
 * a Map read is not something React can subscribe to. Every other input to that overlay is already
 * reactive; this supplies the missing edge — see the long note at step (0b) for why the (0c)
 * precedent of "state the staleness and rely on `liveStatus`" is not sound for a DEATH, which is
 * precisely the event after which no further status write is promised.
 *
 * A status write is the START of the race (the terminal status is set before the ledger IPC is even
 * issued), so the ladder is re-armed by a change to `statusMap` and by nothing else. It returns a
 * NUMBER rather than the registry's contents so that a caller memoizing over it does not have to
 * care what moved — the same shape `useNewAgentGraceTick` uses for the grace deadline.
 */
function useDeadSessionWakeup(statusMap: Record<string, AgentTabStatus>): number {
  const [tick, setTick] = useState(0);
  const [rung, setRung] = useState(0);

  // A new status map restarts the ladder. `setRung(0)` when `rung` is already 0 is a React bail-out,
  // not a render, so the common case (nothing dying) costs nothing.
  useEffect(() => {
    setRung(0);
  }, [statusMap]);

  useEffect(() => {
    if (rung >= DEAD_SESSION_WAKE_RUNGS_MS.length) return;
    const h = setTimeout(() => {
      setRung((r) => r + 1);
      setTick((t) => t + 1);
    }, DEAD_SESSION_WAKE_RUNGS_MS[rung]);
    return () => clearTimeout(h);
  }, [rung, statusMap]);

  return tick;
}

export interface OverlaidStatus {
  /** The overlaid map: observed-attention correction, new-agent calm, dead-session calm, the
   *  green-while-delegating promotion, then the two worker-attention bubbles. This is what a ROW's
   *  colour and the sort order read. */
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
  /** agentId → why its session ended, for step (0b). Injected for exactly the reason
   *  `publishedStatusFor` injects the parameter of the same name — a module-level registry read is
   *  not something a test can drive — and defaulted to the live window-local reader at this
   *  OUTERMOST boundary so every production caller gets the real de-redding without passing
   *  anything. `undefined` from it means "this window has no reading", NEVER "the agent is alive";
   *  `isRecoverableDeadSession` answers false for it and demotes nothing.
   *
   *  The default is not decoration and it must stay EXERCISED: bead sparkle-lgbwf is the standing
   *  finding that a seam every test overrides leaves the line supplying the real value covered by
   *  nothing — delete it and the suite stays green while the bug walks back in. So
   *  `useOverlaidStatus.deadSessionParity.test.ts` drives this BOTH ways: injected, and omitted with
   *  the real `deadSessionRegistry` seeded through its own `noteAgentDeath`.
   *
   *  Sitting next to `hasBackgroundTasksOf` is safe here in a way roborev 65465 warns it often is
   *  not: that finding was about two ADJACENT, IDENTICALLY TYPED positional parameters silently
   *  swapping. `(id) => boolean` and `(id) => DeathCause | undefined` are not mutually assignable,
   *  so a slid argument is a compile error rather than a behaviour change. */
  deathCauseOf: (id: string) => DeathCause | undefined = deathCauseForAgent,
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
  // (0b) AMBER, NOT RED, FOR A SESSION THE APP IS ABOUT TO RESTART.
  //
  // ⚠️ THIS STEP WAS MISSING HERE, AND THAT ABSENCE WAS THE BUG — the same shape as (0c) below,
  // one overlay later. `composeRollup` has applied `withDeadSessionCalm` at its "step 0b" since the
  // overlay was written, and this parallel copy never did, so the two chains DISAGREED ABOUT THE
  // SAME AGENT: an upstream 529 kills a session, `statusEngine.exit()` writes `errored`, the dock
  // badge / TopBar / concierge feed all read the agent as amber `lapsed` off the published map —
  // and the Build row, whose `st` descends from THIS chain, painted RED. `errored` is not in
  // `stallEscalation.GRAY_STATUSES`, so `grayFloorFor` returns undefined, so `dotFillFor` returns
  // undefined, so `StatusDot` paints `AGENT_STATUS.errored.color`. One 529 wave painted ~40 rows
  // "needs you" in a single night, each of them asking the founder to fix something only the
  // resurrection sweep can fix. His words, which are the whole reason `deadSessionAttention` exists:
  // *"there's nothing I can do to resolve this. So why am I seeing this?"*
  //
  // ── WHY EXACTLY HERE, AND NOT ANYWHERE ELSE IN THE CHAIN ──────────────────────────────
  // AFTER (0) `useNewAgentCalm` and BEFORE (0c) `withBackgroundTaskGreen` — byte for byte the
  // position `composeRollup` uses, because "keeping the two calls at the same position is the only
  // thing that holds them equal" (this file's own header), and `publishedRollupAgreement.test.ts`
  // is structurally blind to a divergence between them.
  //
  // The position is also forced on its own terms, by `deadSessionAttention`'s header: it must run
  // ON THE RAW MAP, BEFORE THE WORKER BUBBLES, because *"a bubbled red is indistinguishable from a
  // parent's own once it lands, so a dead worker's false red has to be corrected BEFORE it can
  // spread to the orchestrator"*. Move it after (1)/(2) and a dead worker's red is already on the
  // head — demoting the worker then leaves the ORCHESTRATOR red for a worker the app is about to
  // restart, which is the founder's complaint one level up. Move it after (3) `withUnmergedWork`
  // and the same argument applies with a gray in the middle.
  //
  // It sits after (0) rather than before it for the reason (0) sits where it does: `calmNewAgent`
  // is about a briefless agent that never started, `withDeadSessionCalm` about one that started and
  // ended. Neither reads the other's output — a `new` agent has no death record and a dead one is
  // not fresh — so this pairing is chosen to MATCH `composeRollup`, which is the binding
  // constraint, not to resolve a conflict.
  //
  // ── REACTIVITY: A REGISTRY READ IS NOT REACTIVE, AND HERE THAT MATTERS MORE THAN AT (0c) ─────
  // `deathCauseOf` reads a module-level Map, not a store, so this memo cannot re-run merely because
  // a death was recorded. (0c) states the same limitation and accepts it, on the grounds that
  // `liveStatus` moves when a background task finishes. THAT ARGUMENT DOES NOT TRANSFER, and the
  // difference is what makes the tick below necessary rather than tidy:
  //
  //   `statusEngine.exit()` writes the terminal status FIRST — `this.set(… "errored" …)` — and
  //   only then calls `reportDeath`, which awaits ONE `agent_life_close` IPC round trip inside
  //   `deathRecordWriter.recordDeath` before `noteAgentDeath` lands. So the store write that would
  //   have recomputed this memo has ALREADY HAPPENED by the time the registry has the cause. The
  //   memo is stale by construction, not by accident.
  //
  //   And nothing is guaranteed to move it again. In the case this fix is for — an upstream wave
  //   that kills the whole fleet at once — there is no surviving agent left to write a status, so
  //   the rows would sit RED until some unrelated interaction happened to re-render. Permanently,
  //   for the founder, in exactly the scenario the amber tier was invented for.
  //
  // So the wake-up is a BOUNDED trailing ladder, not a poller: see `useDeadSessionWakeup`. It fires
  // a fixed number of times after the input map last moved and then disarms completely, so a quiet
  // app arms no timer at all. That covers the async gap above without adding a permanent re-render
  // heartbeat to the sidebar. `deadSessionWake` is in the dep list for that reason and no other.
  const deadSessionWake = useDeadSessionWakeup(s0);
  const s0b = useMemo(
    () => withDeadSessionCalm(agents, s0, deathCauseOf),
    // `deadSessionWake` is deliberate — see the note above; it is the only input that changes when
    // a death is recorded with no store write behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, s0, deathCauseOf, deadSessionWake],
  );

  // (0b-ii) A ROW WHOSE WORK IS PROVEN LANDED IS FINISHED, NOT BLOCKED.
  //
  // Beside the dead-session calm and for the same reason: both answer "is the founder really the
  // only actor who can clear this?", and both must run BEFORE the worker bubbles below, because once
  // a red has bubbled to an orchestrator head an inherited red is indistinguishable from an own one
  // — the head would go on wearing an alarm about a worker whose work is already on main.
  //
  // Narrow by construction: it touches only the INFERRED reds (`blocked`, `errored`), never a
  // demonstrated ask, and only on positively-proven landing. See `engine/landedRedVeto`.
  const s0bii = useMemo(
    () =>
      withLandedRedVeto(agents, s0b, (id) => resolveStage(branchStatus[id], workflowStage[id])),
    [agents, s0b, branchStatus, workflowStage],
  );

  const s0c = useMemo(
    () => withBackgroundTaskGreen(agents, s0bii, hasBackgroundTasksOf),
    [agents, s0bii, hasBackgroundTasksOf],
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
