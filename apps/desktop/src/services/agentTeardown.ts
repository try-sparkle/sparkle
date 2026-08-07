// REMOVING A ROW OPENS A TRACE ONLY A PANE CAN CLOSE — so the sites where no pane exists must say so.
//
// `useProjectStore.removeAgent` unconditionally starts a `close:<id>` waterfall (projectStore.ts),
// and its only remover is `perfEnd` in AgentPane's unmount cleanup. That is correct for the ordinary
// close, where the row's pane is mounted and unmounts in response. It leaks everywhere a row is
// removed WITHOUT a pane ever having mounted, and the entry is permanent: `openTraceKinds()` is the
// jank monitor's only attribution channel on macOS WKWebView, so each leak misattributes every later
// stall in the session, growing monotonically.
//
// TWO CALLERS, AND ONLY TWO ON PURPOSE — `buildAgentSpawn`'s pre-launch teardown and `workerSpawn`'s
// rollback. THE TEST FOR MEMBERSHIP IS THE OUTCOME, NOT ITS CAUSE: the site must be able to name why
// NO PANE EVER MOUNTED for that row. There are two ways to earn that, and each caller uses a
// different one — so neither "the throw is synchronous" nor "`open` never ran" is the rule, because
// each is true of only one of them:
//
//   * `open` NEVER RAN — `workerSpawn`'s rollback. The row is added with `select: false` and
//     `runtime.open(workerId)` first runs in `runSpawn`, which the rollback IS the failure to reach.
//     It is not synchronous at all: it is reached from `catch` after `await prepareWorkerWorkspace` /
//     `await writeWorkerManifest`, a real `git worktree` cut and many render commits later.
//   * `open` RAN BUT NOTHING RENDERED — `buildAgentSpawn`. It really does call
//     `runtime.open(id)`/`landInAgent`, which is why the teardown has to `close(id)` a few lines
//     above its `removeAgentWithoutPane`. It qualifies because the whole `try` body is await-free, so
//     the `catch` runs in the SAME TICK and React never rendered in between.
//
// Both halves are stated because a one-line rule has now been wrong here three times, each time in
// the costly direction — a reader checks their site against a criterion that fits only the other
// caller, concludes they do not qualify, and leaves a dangle this helper would have handled
// (roborev 60130, 60142, 60144).
//
// THE DECISION CANNOT MOVE INTO THE STORE. `removeAgent` cannot decide this for itself, because the
// genuine close paths deliberately `close()` BEFORE `removeAgent` precisely so the pane unmounts —
// so any store-level test like "is the id still open?" reads false on exactly the paths whose
// measurement is the point, and would suppress the waterfall everywhere (roborev 60088 proposed it).
//
// AND IT CANNOT BE EXTENDED TO THE OTHER TEARDOWN SITES, which is why they are not here. Asking
// "will a surface still exist to end this?" is unanswerable at `spinDownWorker`, `closeBuildAgent`
// and `AgentSidebar`'s teardown: it differs between the main and satellite windows (the satellite
// mounts on `openAgentIds` alone, for a project that IS torn out and is NOT visited), and at the
// awaiting sites it turns on whether the await lands before or after React commits. A guard
// mirroring the main window's mount gate was written and REMOVED for that reason — guessing wrong in
// the cancel direction deletes a LIVE trace and silently stops measuring closes, which is worse than
// the dangle.
//
// SO THE DANGLE AT THOSE SITES IS REAL, PRESENT, AND UNFIXED — tracked in `sparkle-vmfda`, not
// neutralised by anything here. A read-side age bound in `openTraceKinds` (ignore/prune stale
// entries, making a missed cancel harmless everywhere) WAS attempted and rejected: a wall-clock
// bound prunes the trace during precisely the long stall it exists to attribute, breaking
// `perfTrace.jankLabel.test.ts`. A correct version must count RUNNING time, which `perfTrace`
// already distinguishes for suspend — so it belongs in that module, and does not exist today.
import { useProjectStore } from "../stores/projectStore";
import { perfCancel } from "../perfTrace";

/**
 * Remove an agent row whose pane never mounted, cancelling the `close:` trace `removeAgent` opens.
 *
 * Use this wherever a row is torn down without a live pane. Where a pane IS mounted, call
 * `removeAgent` directly — the unmount ends the trace and that measurement is the point.
 */
export function removeAgentWithoutPane(projectId: string, agentId: string): void {
  useProjectStore.getState().removeAgent(projectId, agentId);
  // AFTER, never before: `removeAgent` is what starts the trace.
  perfCancel(`close:${agentId}`);
}

