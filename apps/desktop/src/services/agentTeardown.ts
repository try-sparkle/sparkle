// SUPPRESSING A CLOSE MEASUREMENT FOR A CLOSE THAT NEVER HAPPENED.
//
// READ THIS FIRST, BECAUSE THIS FILE USED TO CLAIM THE OPPOSITE. It previously carried the whole
// balance guarantee for `removeAgent`'s `close:<id>` trace, argued that only two call sites could
// ever qualify, and recorded the leak at every other teardown site as "real, present, and unfixed"
// (bead sparkle-vmfda). That is no longer where the guarantee lives, and THE `close:` DANGLE is no
// longer present. `projectStore.removeAgent` now opens that trace ONLY while a pane is actually
// mounted to end it, asking `services/agentPaneRegistry` — which the pane itself writes. The
// balance is therefore structural and cannot be forgotten by a caller, which is what this file
// could never achieve by asking each site to reason about it (bead sparkle-bxidpw).
//
// READ THAT AS `close:` AND NOTHING ELSE. Its sibling `switch:<id>` (`projectStore.selectAgent`) is
// still ungated and still leaks into the SAME `during` attribution field, by the same mechanism —
// only a mounted pane can end it. The registry gate is not the fix for it and would be wrong there;
// the argument is at `selectAgent`, and the debt is `sparkle-sl3g` / `sparkle-5uuh`. So this file
// no longer says the attribution channel is clean — it says one of its two producers is.
//
// WHY THE OLD ARGUMENT FAILED, KEPT BECAUSE IT IS STILL TRUE AND STILL WORTH KNOWING. The question
// "will a surface exist to end this trace?" genuinely cannot be answered at `spinDownWorker`,
// `closeBuildAgent`, `tearDownKeepingBranches`, `discardAgent` or `AgentSidebar`'s teardown: panes
// mount lazily per project, so the answer turns on where the user has clicked this session, on
// whether the project has been torn out into a satellite window, and — at the awaiting sites — on
// whether the await lands before or after React commits. Every attempt to encode that as a rule at
// the call site was wrong, three times, always in the costly direction (roborev 60130, 60142,
// 60144). The resolution was not a better rule but a different question-asker: the PANE knows,
// because it is the thing that mounted, so it records itself and the store looks it up.
//
// AND WHY THE STORE-LEVEL GATE THAT WAS REJECTED IS NOT THIS ONE. roborev 60088 proposed gating on
// `runtimeStore.openAgentIds` and was correctly refused: every genuine close calls `close(id)`
// BEFORE `removeAgent` precisely so the pane unmounts, so that flag reads false on exactly the paths
// whose measurement is the point. The registry reads a different fact — whether React has COMMITTED
// the unmount — which on the synchronous close paths it has not. See `agentPaneRegistry` for the
// full argument that the gate is strictly dominant: it emits the waterfall in every case that emits
// one today, and skips it in exactly the cases that leak today.
//
// SO WHAT IS LEFT FOR THIS HELPER. Not leak prevention — the store handles that. What remains is
// suppressing a MEANINGLESS measurement: a spawn that failed and rolled back is not a close, and if
// a pane did happen to mount before the rollback, the row's removal would unmount it and emit a
// `close … (total)` waterfall for an interaction the user never performed. `perfCancel` drops it
// silently. On the ordinary path for both callers no pane ever mounted, the store opened nothing,
// and the `perfCancel` is a harmless no-op — belt and braces, deliberately.
//
// TWO CALLERS, AND ONLY TWO ON PURPOSE — `buildAgentSpawn`'s pre-launch teardown and `workerSpawn`'s
// rollback. THE TEST FOR MEMBERSHIP IS THE OUTCOME, NOT ITS CAUSE: the site must be a SPAWN that
// failed, so that any close waterfall it produced would describe nothing. Do NOT add a genuine
// teardown site here — those are real closes, and where their pane is mounted their waterfall is
// wanted. There is no longer any cost to leaving them on plain `removeAgent`, which is the point.
import { useProjectStore } from "../stores/projectStore";
import { perfCancel } from "../perfTrace";

/**
 * Remove an agent row for a SPAWN THAT FAILED, suppressing any `close:` waterfall it would emit.
 *
 * Use this only from spawn rollback paths. For a genuine teardown call `removeAgent` directly: the
 * store opens a `close:` trace only when a mounted pane is there to end it, so nothing leaks, and
 * where a pane IS mounted the measurement is the whole point.
 */
export function removeAgentWithoutPane(projectId: string, agentId: string): void {
  useProjectStore.getState().removeAgent(projectId, agentId);
  // AFTER, never before: `removeAgent` is what would start the trace.
  perfCancel(`close:${agentId}`);
}
