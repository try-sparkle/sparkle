// WHICH AGENT IDS HAVE A LIVE `AgentPane` IN *THIS* WINDOW, RIGHT NOW.
//
// This exists for exactly one consumer: `projectStore.removeAgent`, which opens the `close:<id>`
// perf waterfall. That trace can only ever be ENDED by `AgentPane`'s unmount cleanup (`perfEnd`), so
// opening one for a row that has no pane leaks a permanent entry into `perfTrace`'s module-scoped
// `traces` map — and `openTraceKinds()` then names that ghost as an in-flight interaction on EVERY
// jank stall for the rest of the process. Measured in a real session: `"during":"close×37"` on every
// stall line for hours, whatever the actual cause, monotonically growing. That is not merely noise —
// it is the jank monitor's ONLY attribution channel on macOS WKWebView (no Long Tasks API), so a
// poisoned `during` actively obstructs diagnosing a freeze (bead sparkle-bxidpw, sparkle-vmfda).
//
// WHY A REGISTRY RATHER THAN A PER-CALL-SITE JUDGEMENT. The previous attempt asked each teardown
// site to declare "did a pane ever mount for this row?" and could only answer it at two of them
// (`buildAgentSpawn`'s and `workerSpawn`'s spawn rollbacks, via `removeAgentWithoutPane`). It is
// genuinely unanswerable at the others: panes mount LAZILY per project (`Workspace`'s `live` memo
// gates on visited-project + `openAgentIds` + not-torn-out), so whether one exists depends on where
// the user has clicked this session and on which window is asking. A call site cannot know that. The
// PANE can — it is the thing that mounted. So the pane records itself here and the question becomes
// a lookup instead of a guess.
//
// WHY THIS IS NOT THE `openAgentIds` TEST THAT WAS REJECTED. A store-level gate on
// `runtimeStore.openAgentIds` was proposed and correctly refused (roborev 60088): every genuine
// close calls `close(id)` BEFORE `removeAgent` precisely so the pane unmounts, so that flag reads
// false on exactly the paths whose measurement is the point, and gating on it would suppress the
// waterfall everywhere. This registry reads something different — whether React has actually
// COMMITTED the unmount yet — and on the synchronous close paths (`AgentSidebar.teardownAgent`,
// `spinDownWorker`) it has not: `close()` and `removeAgent()` run in the same tick, React 18 batches
// the re-render, and the pane is still mounted when `removeAgent` asks. Those paths keep their
// waterfall, unchanged. Only the paths that `await` a slow git teardown between `close()` and
// `removeAgent()` (`closeBuildAgent`, `tearDownKeepingBranches`, `discardAgent`) read false — and
// those produce NO waterfall today either, because the pane already unmounted and its `perfEnd` ran
// against a trace that had not been started yet. Their `perfStart` is pure leak. So the gate is
// strictly dominant: it emits the waterfall in every case that emits one today, and skips it in
// exactly the cases that leak today.
//
// WHAT THIS DOES **NOT** COVER — `switch:<id>`, WHICH HAS THE IDENTICAL SHAPE AND IS STILL UNGATED.
// `projectStore.selectAgent` opens `switch:<id>` unconditionally and only a mounted pane's
// visibility effect (`settleSwitchTrace`) can end it, so a selection whose pane never mounts leaks
// the same way `close:` used to, into the same `during` field. It is NOT fixed by this module and
// the gate here would be WRONG there: a switch is measured FROM the selection TO the pane painting,
// so on the cold path no pane exists yet by definition and gating would suppress exactly the
// switches worth measuring (three call sites select before `open()` is even called — see the long
// note at `selectAgent`). Tracked at `sparkle-sl3g` and `sparkle-5uuh`. Read every "structural",
// "cannot be forgotten" and "balance guarantee" claim in this file as scoped to `close:`.
//
// PER WINDOW, BY CONSTRUCTION. Each webview (main and every satellite) is its own JS context with
// its own `traces` map and its own copy of this module, so each answers only for the panes it hosts.
// That dissolves the "it differs between the main and satellite windows" objection: neither window
// has to reason about the other's panes, because neither one's `perfTrace` holds the other's traces.

/** Refcount, not a Set. React StrictMode double-invokes effects (mount → cleanup → mount) and a
 *  portal target change can remount a pane, so register/unregister can legitimately overlap or
 *  repeat; counting makes the balance robust where a boolean would drop the id on the first cleanup
 *  of a pair that is still live. Never negative — an unmatched unregister is floored at absent. */
const mountedPanes = new Map<string, number>();

/** Record that an `AgentPane` for `agentId` has mounted in this window. Call from the pane's mount
 *  effect; pair with {@link unregisterMountedPane} in that effect's cleanup. */
export function registerMountedPane(agentId: string): void {
  mountedPanes.set(agentId, (mountedPanes.get(agentId) ?? 0) + 1);
}

/** Record that an `AgentPane` for `agentId` has unmounted. Safe to call for an id that was never
 *  registered (a no-op), so a cleanup can run unconditionally. */
export function unregisterMountedPane(agentId: string): void {
  const n = (mountedPanes.get(agentId) ?? 0) - 1;
  if (n > 0) mountedPanes.set(agentId, n);
  else mountedPanes.delete(agentId);
}

/** Is there a live `AgentPane` for `agentId` in this window? True means something WILL run
 *  `perfEnd("close:<id>")` when the row goes, so a `close:` trace opened now is guaranteed to be
 *  balanced. False means nothing can ever end it, so it must not be opened.
 *
 *  ANSWERS FOR `close:` ONLY. A false here does NOT mean "no pane will ever exist" — it means "none
 *  exists right now", which is the correct test for a trace about a pane that is going away and the
 *  wrong one for a trace about a pane that is arriving. See the `switch:` note in this file's
 *  header before reusing it as a general "is a trace endable?" predicate. */
export function isAgentPaneMounted(agentId: string): boolean {
  return mountedPanes.has(agentId);
}

/** Clear the registry so a test starts from a known state — this map is module-scoped and outlives
 *  any single test. Note the deliberate asymmetry with `perfTrace.__resetTracesForTest`: resetting
 *  THIS map is always safe (it models the world, and a test that mounted nothing genuinely has
 *  nothing mounted), whereas resetting the TRACES map can hide the very leak under test. */
export function __resetMountedPanesForTest(): void {
  mountedPanes.clear();
}
