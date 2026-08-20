// WHICH ORCHESTRATORS BELONG TO THE SELECTED EPIC — the pure half of the epics column's one gesture.
//
// The founder: "When I click on a specific Epic row, I want it to filter the build orchestrators to
// be only the ones that refer to or are related to that Epic." This is that rule, stated once, as a
// function of data rather than of React state, so it can be tested without mounting a column.
//
// ── THE MEMBERSHIP RULE IS NOT RESTATED HERE ───────────────────────────────────────────────────
//
// An orchestrator belongs to the epic when the bead it is working IS that epic or any DESCENDANT of
// it. That edge is `services/beads.childrenOf`, and it is deliberately not re-derived in this file:
// `scripts/lib/epic-membership-guard.sh` fails CI on a second definition of epic membership
// anywhere outside the resolver, because this codebase already grew three incompatible answers to
// "what is an epic" and the founder's constraint is "keep it one". So this module composes
// `childrenOf`; it never re-derives the edge or the type test for itself.
//
// ── AND WHY AN ORCHESTRATOR'S OWN BEAD IS NOT THE WHOLE QUESTION ───────────────────────────────
//
// A build orchestrator frequently carries no `beadId` at all while the WORKERS it spawned each
// carry one — that is the normal shape of a fan-out, and it is why `AgentSidebar` already asks the
// same widened question when it decides what a row's uncommitted work covers. Narrowing on the
// orchestrator's own bead alone would therefore hide exactly the orchestrators the founder is
// looking for: the ones with the most work under them. A head matches when IT or ANY agent beneath
// it is working a bead in the epic.

import { childrenOf, type Bead } from "../services/beads";

/** The shape this rule needs from an agent, and nothing more — so a test can hand it two fields
 *  rather than constructing a whole `Agent`, and so this module never grows a dependency on the
 *  desktop's agent type. */
export interface EpicFocusAgent {
  id: string;
  parentId?: string | null;
  beadId?: string;
}

/**
 * Every bead id that counts as "inside" `epicId` — the epic itself plus its descendants.
 *
 * The epic's OWN id is a member, which is the case a descendants-only set silently drops: an
 * orchestrator pointed straight at the epic bead is the most direct possible match and would
 * otherwise be the one row the filter hid.
 */
export function beadIdsInEpic(allBeads: readonly Bead[], epicId: string): ReadonlySet<string> {
  const out = new Set<string>([epicId]);
  for (const child of childrenOf(allBeads, epicId)) out.add(child.id);
  return out;
}

/**
 * The ids of the agents that survive the narrowing, or `null` for "no narrowing at all".
 *
 * `null` IS NOT AN EMPTY SET, and conflating the two is the bug this signature exists to prevent:
 * an empty set means "this epic has no orchestrators", which must render an empty column, while
 * `null` means "no epic is selected", which must render every agent. A single `Set` return would
 * make the unselected default indistinguishable from a fully-filtering selection — and since
 * nothing is selected on launch, getting it backwards empties the build column for everyone.
 */
export function agentIdsInEpic(
  agents: readonly EpicFocusAgent[],
  allBeads: readonly Bead[],
  epicId: string | null,
): ReadonlySet<string> | null {
  if (!epicId) return null;
  const beadIds = beadIdsInEpic(allBeads, epicId);

  // Which agents are DIRECTLY on a bead in the epic — heads and workers alike, in one pass.
  const direct = new Set<string>();
  for (const a of agents) {
    if (a.beadId && beadIds.has(a.beadId)) direct.add(a.id);
  }

  // …then lift each match up to its head, so an orchestrator whose own bead is unset still survives
  // on the strength of the workers under it. Walking parents rather than building a children map:
  // the chain is short and this way a worker of a worker is covered without a second traversal.
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out = new Set<string>();
  for (const a of agents) {
    let cur: EpicFocusAgent | undefined = a;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id); // a corrupt parent cycle must not hang the render
      if (direct.has(cur.id)) {
        out.add(a.id);
        break;
      }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  // A head whose WORKER matched: the worker is in `direct`, and the loop above added the worker but
  // not its parent. Walk the other way once to bring the heads in.
  for (const a of agents) {
    if (!direct.has(a.id)) continue;
    let cur = a.parentId ? byId.get(a.parentId) : undefined;
    const seen = new Set<string>([a.id]);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return out;
}
