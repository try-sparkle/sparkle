// WHICH AGENTS THE STATUS TICK ASKS GIT ABOUT — and the answer is "all of them", which it was not.
//
// THE BUG. The sidebar's 15s tick targeted only agents whose PANE WAS OPEN (plus the orchestrator
// parent of an open worker, so a worker's "Merged" could read its parent's stage). Every closed row
// was therefore never handed to `project_agents_status` by anything: `branchStatus[id]` stayed
// undefined for its whole life, `resolveStage(undefined, …)` fell to `building_unsaved`,
// `hasUnmergedCommittedWork` returned false, and `engine/unmergedAttention.withUnmergedWork` — the
// overlay that exists to say "this branch still needs you" — never fired.
//
// The concrete casualty was agent 532be93b, displayed as idle with no activity and one click from
// being closed as an empty agent, while its branch carried ELEVEN unpushed commits. The app was not
// wrong about git; it had never asked. Its name in the UI was "Build 4" — the generic default — and
// that is the tell: the naming tick in AgentSidebar already polls CLOSED name-from-work candidates
// precisely because "a build/worker that did real work while its pane was CLOSED can be stuck on its
// 'Build N' default forever". Two ticks, the same closed agent, and only one of them had been taught
// that closed does not mean idle.
//
// THE SPLIT, and why it is two batches rather than one bigger one. `probePrState` is a per-CALL
// flag, not per-agent, and it is what turns a status poll into a network operation: an origin fetch
// plus a `gh` PR probe (~0.5s of subprocess each) that re-runs every PR_REPROBE_TTL (90s) even when
// the git fingerprint has not moved. Handing 46 closed agents to the probing batch would buy a
// steady network storm for a fact — "is there a PR open?" — that nobody is looking at, since the
// pane is closed. So:
//
//   • PROBED (unchanged from before): open agents + the orchestrator parent of any open worker.
//     Someone is looking at these; they get the full picture including PR state.
//   • LOCAL (new): every other non-shell agent. Pure local git — ahead/behind/dirty and reachability
//     are all ref reads — which is exactly and only what `hasUnmergedCommittedWork` needs to stop a
//     branch full of commits from reading as empty. PR state waits until the pane is opened.
//
// The cost of the new batch is bounded by the Rust side, not by this list: `project_agents_status`
// fingerprints each agent (own tip + base tip + main's tips + worktree index mtime) and SKIPS an
// unchanged one before doing any per-agent work. So a fleet of idle closed agents costs one cheap
// rev-parse apiece per tick after the first, and nothing else.
//
// Pure and React-free so the rule is unit-tested on its own; the sidebar effect just calls it.

/** The fields the split reads. Structural, so callers pass their own agent record unadapted. */
export interface PollableAgent {
  id: string;
  /** "build" | "worker" | "think" | "shell". */
  kind: string;
  parentId: string | null;
}

/** shell agents have no git workflow at all (Rust skips them too), so polling one is pure overhead.
 *  `think` IS included: Rust skips it as well, but keeping the predicate identical to the sidebar's
 *  long-standing `hasWorkflow` avoids a second, drifting answer to "does this agent have git". */
const hasWorkflow = (a: PollableAgent): boolean => a.kind !== "shell";

/**
 * Split a project's agents into the two status-poll batches.
 *
 * Every non-shell agent lands in exactly one of them — that totality is the fix. Order within each
 * batch follows `agents`, so the batch handed to Rust is stable tick to tick.
 */
export function splitStatusPollTargets<T extends PollableAgent>(
  agents: readonly T[],
  openAgentIds: readonly string[],
): { probed: T[]; local: T[] } {
  const open = new Set(openAgentIds);
  const byId = new Map(agents.map((a) => [a.id, a]));

  // The PROBED set, exactly as the tick has always computed it: open agents, plus the orchestrator
  // parent of each open worker even when that parent's own pane is closed — a worker's "Merged"
  // reads its parent's stage, so the parent needs the PR-aware answer too.
  const probedIds = new Set<string>();
  for (const a of agents) {
    if (!open.has(a.id) || !hasWorkflow(a)) continue;
    probedIds.add(a.id);
    if (a.kind === "worker" && a.parentId) {
      const parent = byId.get(a.parentId);
      if (parent && hasWorkflow(parent)) probedIds.add(parent.id);
    }
  }

  const probed: T[] = [];
  const local: T[] = [];
  for (const a of agents) {
    if (!hasWorkflow(a)) continue;
    (probedIds.has(a.id) ? probed : local).push(a);
  }
  return { probed, local };
}
