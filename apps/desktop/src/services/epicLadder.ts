// epicLadder — which epic does this agent's work ladder up to, and which agents ladder up to this
// epic. The two directions of the founder's requirement, answered from state that ALREADY EXISTS.
//
// ── WHY THERE IS NO `ladder` FIELD ────────────────────────────────────────────────────────────
// The obvious design is a new pointer on the goal — `goal.ladder = {epicId, epicGoalText}`. It was
// rejected for three reasons, in increasing order of how much they cost:
//
//   1. IT IS ALREADY RECORDED. `AgentTab.epicId` is stamped on a build agent by
//      `sendToBuild.prepareHandoff`, and `AgentTab.beadId` is stamped on a worker by
//      `workerSpawn.spawnWorker`. `beads.parentEpicOf` already turns the second into the first. A
//      new field would be a fourth way to say a thing three existing mechanisms already say.
//   2. A GOAL-LEVEL POINTER DOES NOT SURVIVE THE GOAL. An agent rewording its objective replaces
//      the goal record, and the epic it is working under does not change when it does. Membership is
//      an AGENT-level fact; hanging it off the goal makes it evaporate on a routine re-assert.
//   3. A COPIED STRING GOES STALE. Freezing `epicGoalText` into every child reproduces exactly the
//      problem `AgentGoal.escalatedGoalText` exists to detect — a row showing a quote two edits old
//      and reading as a live claim. Deriving it means every reader sees the epic goal that is
//      actually in force.
//
// So this module is a pair of pure lookups over the snapshot the board already polls. Nothing is
// persisted, nothing can drift, and an epic goal edited a second ago is in force everywhere at once.
import {
  childrenOfIndexed,
  epicIndexOf,
  isEpicIndexed,
  parentEpicOfIndexed,
  type Bead,
} from "./beads";
import type { AgentTab } from "../types";

/** The agent fields this module reads. Kept structural so a test builds two keys, not an AgentTab. */
export type LadderAgent = Pick<AgentTab, "id" | "epicId" | "beadId">;

/**
 * The epic whose goal this agent's work ladders up to, or null.
 *
 * TWO ROUTES, and `epicId` wins. A build agent handed an epic carries `epicId` directly. A worker
 * carries `beadId` — the ONE task bead it implements — and its epic is that bead's parent.
 *
 * ⚠️ `prepareHandoff` stamps BOTH on an orchestrator (the same bead as `epicId` also lands in
 * `beadId`, so the board's Shipped column is reachable for hand-filed work). Reading `beadId` first
 * would therefore ask `parentEpicOf` about an EPIC, which resolves to that epic's own parent when
 * it has one — silently attributing an orchestrator's work to the wrong epic in exactly the nested
 * case. `epicId` is the direct statement; it is read first for that reason, not by preference.
 *
 * ⚠️ BUT `epicId` IS NOT ALWAYS AN EPIC, so being read first is not the same as being returned
 * verbatim (bead sparkle-o05vcs.5). `sendToBuild` in `mode: "task"` hands an orchestrator ONE TASK
 * bead and stamps that task's id into `epicId` — the shape `docs/orchestrators-per-task.md` calls a
 * TASK-LEVEL ORCHESTRATOR, and the only shape that produces one today. Returning it unresolved put
 * that agent on a rung nobody queries: `agentsLadderingTo` is called with EPIC ids, so an
 * orchestrator building `e1.t1` laddered to `e1.t1` and was absent from `e1`'s ladder entirely
 * (recorded as a known defect in PRD/epic-linkage-at-spawn.md). BOTH fields are therefore resolved
 * the same way — the bead is the answer when it IS an epic, its parent epic otherwise — which is
 * what makes "how many orchestrators are on this task, and under which epic" answerable from the
 * roster at all, and so what makes the one-per-task decision auditable rather than merely stated.
 *
 * WHAT THIS DOES **NOT** TOUCH: the raw `AgentTab.epicId` field stays the BINDING, and the binding
 * is what `sendToBuild.prepareHandoff` and `planView.orchestratorNameForEpic` match on to keep the
 * link 1:1. This module derives a LADDER VIEW over that binding. Resolving here cannot loosen the
 * binding, and re-deriving the binding here would be the second definition this codebase's
 * epic-membership guard exists to prevent.
 */
export function epicIdForAgent(agent: LadderAgent, beads: readonly Bead[]): string | null {
  // `epicId` first, `beadId` as the fallback — see the two warnings above for why the order is
  // load-bearing in one direction and why neither answer may be returned unresolved.
  const claimed = agent.epicId ? agent.epicId : agent.beadId;
  if (!claimed) return null;
  const index = epicIndexOf(beads);
  // `index.byId`, NOT `beads.find`. This runs once per agent inside `agentsLadderingTo`, over a
  // snapshot the board re-polls every 5s, so a linear scan here is O(agents x beads) — the exact
  // per-item store scan `beads.ts` records at 3.4-4.0s on the 7,364-bead store. The index is
  // already in hand one line up and answers precisely this lookup.
  const bead = index.byId.get(claimed);
  if (!bead) {
    // AN UNKNOWN id is answered DIFFERENTLY on the two routes, and deliberately. The board polls, so
    // an agent can name a bead a beat before the snapshot holds it; for an explicitly stamped
    // `epicId` the field is a direct statement of intent and trusting it keeps the agent visible on
    // its epic through a partial read. `beadId` has no such statement behind it — it may be any
    // bead — so an unresolvable one stays null, exactly as before.
    return agent.epicId ? claimed : null;
  }
  // An agent whose OWN bead is an epic is already at the top of the ladder — attributing it to that
  // epic's parent would be a rung too far.
  if (isEpicIndexed(index, bead)) return bead.id;
  return parentEpicOfIndexed(index, bead)?.id ?? null;
}

/** Every agent whose work ladders up to `epicId`, in roster order. */
export function agentsLadderingTo<T extends LadderAgent>(
  agents: readonly T[],
  beads: readonly Bead[],
  epicId: string,
): T[] {
  return agents.filter((a) => epicIdForAgent(a, beads) === epicId);
}

/**
 * Every agent whose work belongs to `epicId` OR to one of its DIRECT CHILDREN.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM {@link agentsLadderingTo} ─────────────────────────────────
 * They answer different questions and the difference is not cosmetic (roborev 65856).
 * `agentsLadderingTo` answers "whose goal ladders up to THIS epic", and it correctly EXCLUDES a
 * sub-epic's orchestrator — that agent ladders to the sub-epic, which is its own rung.
 *
 * `engine/epicGoalRollup` needs the other question. It walks the epic's child beads and asks, for
 * each one, "is anybody carrying this slice". When a child bead is itself a sub-epic, the agent
 * carrying it is exactly the one `agentsLadderingTo` filtered out — so feeding the rollup that
 * filtered list made every sub-epic child report `stranded` while an agent was actively building
 * it. A false alarm, on the surface whose own comments say false alarms are what make real ones
 * unreadable.
 *
 * The fix has to be here rather than in the rollup's matching, because a matching rule cannot
 * rescue an agent that is not in the array at all. That was the first attempt and it was inert.
 */
export function agentsForEpicSlices<T extends LadderAgent>(
  agents: readonly T[],
  beads: readonly Bead[],
  epicId: string,
): (T & { sliceIds: string[] })[] {
  const childIds = new Set(childrenOfIndexed(epicIndexOf(beads), epicId).map((b) => b.id));

  /**
   * Which of the epic's slices does this agent's work sit under?
   *
   * ⚠️ AN AGENT CAN COVER MORE THAN ONE, and that is a property of the id scheme rather than a
   * generalisation for its own sake (roborev 65874). `buildEpicIndex` links a bead to EVERY dotted
   * prefix of its id, so `childrenOf(beads, "e1")` contains `e1.sub.t2` as well as `e1.sub` — a
   * grandchild is a slice of the epic too. A worker on `e1.sub.t2` is therefore carrying BOTH the
   * `e1.sub.t2` slice and, by working beneath it, the `e1.sub` slice. Attributing it to only one
   * leaves the other reading "nothing is carrying this" while somebody plainly is.
   *
   * That is what a single `sliceId` got wrong: keyed to the resolved owning epic it missed the
   * agent's own bead, and keyed to the bead it missed the ancestor — and either way its mere
   * presence in the list flipped `started`, turning every slice it failed to match from `open` into
   * a `stranded` false alarm. Worse than the bug it replaced.
   */
  function slicesUnder(a: LadderAgent): string[] {
    const index = epicIndexOf(beads);
    const out = new Set<string>();
    // BOTH EDGES, because epic membership is BOTH edges (roborev 65885). `buildEpicIndex` links a
    // child by its `parent` field OR by a dotted-id prefix, and `beads.ts` states why: a bead
    // reparented later with `bd update <id> --parent <epic>` KEEPS ITS FLAT ID and is matched only
    // by the `parent` half. Walking the id string alone therefore missed every reparented child —
    // and that was not a wash, it traded a false positive for a FALSE NEGATIVE, which is the harder
    // one to notice: the agent was dropped from the list entirely, so a genuinely abandoned sibling
    // slice silently reverted from `stranded` to `open`.
    const queue: string[] = [];
    const seen = new Set<string>();
    if (a.beadId) queue.push(a.beadId);
    if (a.epicId) queue.push(a.epicId);
    while (queue.length > 0) {
      const id = queue.pop();
      // `seen` guards a cycle or a self-parent, which a shared store can certainly contain.
      if (id === undefined || id === "" || seen.has(id)) continue;
      seen.add(id);
      if (childIds.has(id)) out.add(id);
      const parent = index.byId.get(id)?.parent;
      if (parent) queue.push(parent);
      const dot = id.lastIndexOf(".");
      if (dot > 0) queue.push(id.slice(0, dot));
    }
    return [...out];
  }

  const kept: (T & { sliceIds: string[] })[] = [];
  for (const a of agents) {
    const sliceIds = slicesUnder(a);
    // Kept when it carries at least one slice, OR when it is THIS epic's own orchestrator — which
    // carries no single slice (its bead IS the epic) but is what makes the epic "started".
    if (sliceIds.length === 0 && epicIdForAgent(a, beads) !== epicId) continue;
    kept.push({ ...a, sliceIds });
  }
  return kept;
}
