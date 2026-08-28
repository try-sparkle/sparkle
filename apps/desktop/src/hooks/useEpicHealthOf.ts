// THE EPIC → HEALTH WIRING, BUILT ONCE — "is anyone actually building this epic, and how is it
// going", for every surface that asks.
//
// ══ WHY THIS IS A HOOK AND NOT A MEMO IN EACH COLUMN ═══════════════════════════════════════════
// This was a `useMemo` inside `components/EpicsColumn`, which was correct while that column was the
// only surface asking. It is no longer: the Epics ladder's **Unstaffed** rung is decided by the same
// rule (`epicHealth(readings) === "gray"`), and both `EpicsColumn` and `BoardView`'s Epics mode
// render that ladder. Two hand-written copies of this chain is exactly how two columns come to
// disagree about ONE epic — the column↔column drift `useAttentionNotifications`, `engine/workerRollup`
// and `hooks/useOverlaidStatus` each record in their own headers as having already shipped.
//
// It is also the mechanism that keeps the SQUARE and the COLUMN in step. `EpicHealthSquare` paints
// a gray square — the build row's own gray, per the founder's colour-parity rule — and the ladder
// files that same epic under "Unstaffed": one rule, asked once, so a row cannot sit under a header
// that contradicts the mark beside it. Note the two words: `"gray"` is the COLOUR (`EpicHealth` is
// `RollupDot`), `"unstaffed"` is the RUNG.
//
// ══ EVERY IMPORT HERE IS THE SHARED ONE, AND THAT IS THE POINT ═════════════════════════════════
// `rollupViewFor` is the SANCTIONED entry point for "what disc is this build row painted"
// (`useAttentionNotifications` / `engine/workerRollup`). A local `rollupDot` call would be a second
// derivation of the same fact. `agentsForEpicSlices` is the epic↔agent edge, stated once in
// `services/epicLadder`. `engine/epicHealth` is the only place the rollup RULE lives.
//
// ══ COMPUTED ONCE PER SURFACE, NEVER PER ROW ═══════════════════════════════════════════════════
// `rollupViewFor` buckets every worker by `parentId` on construction, so calling this inside a row
// component would rebuild that map once per epic — on a store where the founder has nineteen of
// them and rows re-render on a 5s poll.
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { rollupViewFor } from "../useAttentionNotifications";
import { resolveStage } from "../engine/workflowStage";
import { useFinishedHeads } from "./useFinishedHeads";
import { useOverlaidStatus } from "./useOverlaidStatus";
import { useNudgeFlagSnapshot } from "../useNudgeFlags";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useResurrectableDeadStore } from "../stores/resurrectableDeadStore";
import { agentsForEpicSlices } from "../services/epicLadder";
import { epicHealth, type EpicHealth } from "../engine/epicHealth";
import { beadHealth } from "../engine/beadHealth";
import type { AgentTab } from "../types";
import type { Bead } from "../services/beads";

/**
 * THE ROLLUP VIEW BOTH SURFACES READ — built once per surface, never per row.
 *
 * Extracted so `useEpicHealthOf` and {@link useBeadHealthOf} cannot drift: they are the SAME
 * readings asked two different questions ("which agents sit under this epic" vs "which agents sit
 * on this bead"). The founder's rule that produced the second one — *"I want the way that the
 * square icons work to be exactly the same as the way the build icons work so I don't want any
 * differences between the two"* — is a statement about this shared view, so a second hand-rolled
 * `rollupViewFor` chain here would be the difference he ruled out.
 */
function useRollupView(roster: readonly AgentTab[]) {
  // SUBSCRIBED, NOT `getState()`-ed. Agent status is exactly the thing that changes while the
  // founder is looking at these columns, and a memo reading the store imperatively would paint the
  // health it saw at mount and never move — the "green square on a red epic" version of the bug
  // PR #2357 fixed one column over. These are the same four slices `AgentSidebar` subscribes to for
  // its own discs.
  const rt = useRuntimeStore(
    useShallow((s) => ({
      status: s.status,
      openAgentIds: s.openAgentIds,
      lastObserved: s.lastObserved,
      branchStatus: s.branchStatus,
      workflowStage: s.workflowStage,
    })),
  );
  // THE SAME OVERLAID MAP THE BUILD COLUMN READS, from the same hook. The first cut built its own
  // `withUnmergedWork(roster, RAW status, …)` — the tail of that chain with none of the overlays —
  // and that is not cosmetic: `stallReport` gates its arms behind `isQuiet(status)`, so a head
  // carrying a red worker reads `blocked` in the build column (verdict `active`, NOT finished) and
  // raw `idle` here (verdict `finished`). The two columns then disagreed about the same head in
  // exactly the case the shared verdict was extracted to fix.
  const { calmStatus, graceTick } = useOverlaidStatus(roster);
  // SUBSCRIBED for the same reason `graceTick` is a reactivity anchor below: `rollupViewFor` applies
  // `withDeadSessionCalm` internally through `deathCauseForAgent`, which now also reads the durable
  // `revival_due` list (bead sparkle-nu7gd9). That list arrives on the 15s resurrection sweep with no
  // status write behind it, so without this subscription the square would hold a red epic whose only
  // dead worker the app is already restarting — the "epic squares and build dots share one colour
  // source" case the bead names, on the surface the founder actually reported.
  const durableDead = useResurrectableDeadStore((s) => s.causes);
  const agentsById = useMemo(() => {
    const index = new Map<string, AgentTab>();
    for (const a of roster) index.set(a.id, a);
    return index;
  }, [roster]);
  const nudgeFlags = useNudgeFlagSnapshot();
  const isFinishedOf = useFinishedHeads(agentsById, calmStatus, nudgeFlags);

  return useMemo(() => {
    const openIds = new Set(rt.openAgentIds);
    const stageOf = (id: string) => resolveStage(rt.branchStatus[id], rt.workflowStage[id]);
    // ── THE TWO ARGUMENTS `rollupViewFor` WILL NOT DEFAULT CORRECTLY FOR A SECOND COLUMN ────────
    // Both are documented on its own parameters as things a second caller has to pass:
    //   • `isFinishedOf` — without it a finished orchestrator still carrying a red worker bubble
    //     rolls up RED here while the build column has already gone calm.
    //   • `nudgeFlags` — the nudger's table is a module-level Map with no store behind it, and a
    //     flagged agent is SILENT by definition, so a memo that let this default could never re-run
    //     to learn a flag had arrived (roborev 65408).
    return rollupViewFor(
      roster,
      rt.status,
      openIds,
      rt.lastObserved,
      stageOf,
      undefined,
      undefined,
      undefined,
      isFinishedOf,
      undefined,
      undefined,
      nudgeFlags,
    );
    // `graceTick` is a REACTIVITY ANCHOR, not dead code — nothing in the body mentions it, and
    // `AgentSidebar`'s twin memo lists it for the identical reason (roborev 54830). `composeRollup`
    // samples its own clock in step (0), and for a held `errored` or briefless agent NONE of this
    // memo's other deps ever move again: `rt` is shallow-compared, `roster` is stable, and
    // `nudgeFlags` only moves when a flag arrives. Without it the square holds the pre-deadline
    // reading indefinitely while the build column reddens. `durableDead` is a second such anchor:
    // the durable dead-session list `composeRollup` de-reds against arrives with no status write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, rt, isFinishedOf, nudgeFlags, graceTick, durableDead]);
}

/**
 * `epicId → EpicHealth`, for one pair's roster and one project's bead store.
 *
 * Pass a STABLE empty array for a surface with no project — a fresh `[]` per render re-runs the
 * whole rollup for a column that has nothing in it. Both callers keep a module-level `NO_AGENTS`
 * for exactly that.
 *
 * The returned function is safe to call for an epic id nothing is bound to: `agentsForEpicSlices`
 * answers with an empty list and `epicHealth` reads that as `"gray"` — "not active right now",
 * which is the fact.
 */
export function useEpicHealthOf(
  roster: readonly AgentTab[],
  allBeads: readonly Bead[],
): (epicId: string) => EpicHealth {
  const view = useRollupView(roster);

  return useMemo(() => {
    const { own, dotOf } = view;
    // `own`, not the raw store map: it is the head's status with the worker bubbles stripped, which
    // is what `engine/epicHealth`'s one status-reading arm (`lapsed`) is written against.
    return (epicId: string): EpicHealth =>
      epicHealth(
        agentsForEpicSlices(roster, allBeads, epicId).map((a) => ({
          id: a.id,
          parentId: a.parentId,
          dot: dotOf(a.id),
          status: own[a.id] ?? "new",
        })),
      );
  }, [view, roster, allBeads]);
}

/**
 * `beadId → EpicHealth`, for ONE bead — the child-task square.
 *
 * The founder, 2026-08-22 (bead `sparkle-tsyh5u`): *"Each of the children should also have a status
 * so just like the epic has a square status, the children should also have that status."* This is
 * the wiring that gets a value to a child row; `engine/beadHealth` is the rule (which is
 * `engine/epicHealth`'s rule, delegated — see that file's header for why it must be).
 *
 * ══ WHY THE BINDING IS NOT `agentsForEpicSlices` ═══════════════════════════════════════════════
 * That function answers "which agents are working on a SLICE OF this epic", and it keeps an agent
 * either because the agent's work sits under one of the epic's CHILDREN or because the epic is the
 * agent's own resolved owning epic. Asked about a leaf task it therefore answers with an empty list
 * even when a worker is bound to that very task: the task has no children, and the worker's
 * resolved owning epic is the task's PARENT, not the task. Every child row would have read gray.
 *
 * So the edge here is the one `services/planView.workersForBead` already uses to decide which
 * worker NAMES that same row prints — the agent's own `beadId`. Row and square then cannot
 * disagree about who is on the task, which is the failure mode a second edge would produce.
 *
 * It is deliberately KIND-AGNOSTIC: a build orchestrator dispatched straight at a task bead binds
 * `beadId` the same way a worker does, and it is plainly working on that task. `beadHealth`'s fold
 * handles the head+workers case on its own.
 */
export function useBeadHealthOf(roster: readonly AgentTab[]): (beadId: string) => EpicHealth {
  const view = useRollupView(roster);

  return useMemo(() => {
    const { own, dotOf } = view;
    return (beadId: string): EpicHealth =>
      beadHealth(
        roster
          .filter((a) => a.beadId === beadId)
          .map((a) => ({
            id: a.id,
            parentId: a.parentId,
            dot: dotOf(a.id),
            status: own[a.id] ?? "new",
          })),
      );
  }, [view, roster]);
}
