// Everything an AgentRow needs from the beads store, derived ONCE for the whole fleet.
//
// ══ WHY THIS MODULE EXISTS (bead sparkle-nkoxqs) ════════════════════════════════════════════════
// `components/AgentRow` used to subscribe to the beads store ITSELF, once per row:
//
//     const beads = useBeadsStore((s) => s.byProject[project.id]?.beads ?? NO_BEADS);
//     const board = useBeadsStore((s) => s.byProject[project.id]?.board ?? null);
//
// and then, per row, ran `beadLabel` / `epicForBuild` (each a full-store `find`), `epicPillFor`
// (which additionally allocated a fresh 4-way concatenation of the entire board) and
// `countAgentFeedbackBeads` (a full-store `filter`). With the founder's ~60 agents against a
// ~7,400-bead store that is 60 full-store scans plus 60 whole-board allocations for ONE store
// notification — and it is why switching Plan → Build stayed slow after the board unmounted.
//
// `stores/beadsStore.ts` documents this same hazard at length and fixed one half of it: an
// UNCHANGED poll no longer mints new identities, so it no longer notifies. This module is the other
// half — the cost when the backlog genuinely DOES move, which the store cannot suppress.
//
// ══ TWO PROPERTIES, AND THE SECOND IS THE ONE THAT MAKES `React.memo` BITE ══════════════════════
//
//   1. ONE derivation for N rows. Every rule is asked against a prebuilt index, so the fleet costs
//      O(beads + agents) once instead of O(agents × beads) per notification.
//
//   2. STABLE ENTRY IDENTITY. `AgentRow` is memoized by `agentRowPropsEqual`, which compares by
//      reference. A fresh facts object per agent per poll would defeat that just as thoroughly as
//      the old per-row selectors did — the work would move to the parent but all 60 rows would
//      still re-render. So `buildAgentBeadFacts` takes the PREVIOUS map and reuses the previous
//      object whenever an agent's facts are field-for-field unchanged. A poll that moves one bead
//      then re-renders the rows that bead affects, and nothing else.
//
// ══ NO RULE IS RESTATED HERE ═══════════════════════════════════════════════════════════════════
// This module owns no definition of anything. The epic/bead linkage comes from
// `services/planView`'s `*Indexed` functions (the same bodies the un-indexed helpers delegate to),
// and the feedback-label spelling comes from `engine/retroEvidence.agentFeedbackLabel`. That is
// deliberate: `scripts/lib/epic-membership-guard.sh` exists because this codebase grew three
// incompatible definitions of epic membership, each a locally-reasonable local copy. A hand-rolled
// `Map<id, bead>` and an inline `agent:` prefix test here would have been the fourth and fifth.
import type { AgentTab } from "../types";
import type { Bead, Board } from "../services/beads";
import {
  beadLabelIndexed,
  buildBoardPlanViewIndex,
  buildPlanViewIndex,
  epicForBuildIndexed,
  epicPillForIndexed,
} from "../services/planView";
import { agentFeedbackLabel } from "./retroEvidence";

/** The beads-store-derived display data for ONE agent row. */
export interface AgentBeadFacts {
  /** Worker rows: `"id · title"` for the bead this worker is on. Null on every other kind. */
  beadHover: string | null;
  /** Build rows: `"id · title"` for the epic derived from its workers' beads. Null otherwise. */
  epicHover: string | null;
  /** Build rows: the always-visible epic pill (spec §8). Null otherwise, and null means NO PILL. */
  epicPill: { id: string; title: string } | null;
  /** Build rows: how many beads carry this agent's `agent:<id>` feedback label. 0 otherwise. */
  feedbackCount: number;
}

/**
 * The facts for an agent nothing is known about.
 *
 * A shared frozen singleton, NOT a fresh object per call: it is the render site's fallback for an
 * agent missing from the map, and a fresh `{}` there would hand that row a new prop identity on
 * every parent render — reintroducing exactly the memo defeat this module exists to remove.
 */
export const EMPTY_AGENT_BEAD_FACTS: AgentBeadFacts = Object.freeze({
  beadHover: null,
  epicHover: null,
  epicPill: null,
  feedbackCount: 0,
});

/** An empty previous-map, for the first call. Shared so callers need not allocate one. */
export const NO_AGENT_BEAD_FACTS: ReadonlyMap<string, AgentBeadFacts> = new Map();

function sameFacts(a: AgentBeadFacts, b: AgentBeadFacts): boolean {
  return (
    a.beadHover === b.beadHover &&
    a.epicHover === b.epicHover &&
    a.feedbackCount === b.feedbackCount &&
    a.epicPill?.id === b.epicPill?.id &&
    a.epicPill?.title === b.epicPill?.title &&
    // `?.` collapses null and undefined, so an object-vs-null flip whose id and title both read
    // `undefined` would compare equal above. Compare presence explicitly.
    (a.epicPill === null) === (b.epicPill === null)
  );
}

/**
 * Count every label in the backlog in ONE pass.
 *
 * The inversion that makes the fleet's feedback pills O(beads) instead of O(agents × beads).
 * Deliberately knows nothing about agents — it counts labels — so the question "which label means
 * this agent filed feedback" is still answered in exactly one place
 * (`retroEvidence.agentFeedbackLabel`), which is what keeps the pill and the retire dialog from
 * drifting apart the way they once did.
 */
function countLabels(beads: readonly Pick<Bead, "labels">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of beads) {
    // ONE COUNT PER BEAD, NOT PER LABEL OCCURRENCE — `new Set` is the whole point of this line.
    // The predicate this inversion replaces is `beads.filter((b) => b.labels.includes(label)).length`,
    // which counts BEADS. Counting raw occurrences instead makes a bead carrying `agent:<id>` twice
    // contribute 2 here and 1 there, so the row's FEEDBACK pill would read one number while the
    // retire dialog's "it did report: N" reads another — which is `sparkle-y2p4f`, the exact
    // divergence this module's header claims is impossible, reintroduced by the fast path.
    // `normalizeLabels` only filters non-strings and does NOT de-duplicate, so uniqueness is bd's
    // invariant and not one this client may assume.
    for (const label of new Set(b.labels)) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

/**
 * Derive every agent row's beads-store facts from one snapshot.
 *
 * `previous` is what buys the stable identities described in the header — pass the map returned by
 * the last call. Omitting it is correct but forfeits memoization, so the production call site
 * (`components/AgentSidebar`) always passes one.
 */
export function buildAgentBeadFacts(
  beads: readonly Bead[],
  board: Board | null,
  agents: readonly AgentTab[],
  previous: ReadonlyMap<string, AgentBeadFacts> = NO_AGENT_BEAD_FACTS,
): Map<string, AgentBeadFacts> {
  const beadIndex = buildPlanViewIndex(beads, agents);
  const boardIndex = buildBoardPlanViewIndex(board, agents);
  // Only paid for when some row could actually show a pill. A fleet with no orchestrators (every
  // test that renders worker rows only) skips the whole-backlog label walk.
  const labelCounts = agents.some((a) => a.kind === "build")
    ? countLabels(beads)
    : new Map<string, number>();

  const out = new Map<string, AgentBeadFacts>();
  for (const a of agents) {
    const next: AgentBeadFacts = {
      beadHover: a.kind === "worker" ? beadLabelIndexed(beadIndex, a.beadId) : null,
      epicHover: a.kind === "build" ? epicForBuildIndexed(beadIndex, a.id) : null,
      epicPill: a.kind === "build" ? epicPillForIndexed(boardIndex, a) : null,
      feedbackCount: a.kind === "build" ? (labelCounts.get(agentFeedbackLabel(a.id)) ?? 0) : 0,
    };
    const before = previous.get(a.id);
    out.set(a.id, before && sameFacts(before, next) ? before : next);
  }
  return out;
}
