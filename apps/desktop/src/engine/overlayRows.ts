// WHICH ROWS A STATUS OVERLAY COVERS — the roster, PLUS the app-owned self row.
//
// ══ WHY THE ROSTER ALONE IS THE WRONG SET (the founder's HARD RULE, 2026-08-22) ═══════════════════
// The founder: "I do want it to work exactly like the build agents, so that's the hard rule. The
// colors work the same between the two, and don't let any instruction ever override that."
//
// Every status overlay in this app is handed `project.agents`, and `services/knownAgents.ts` states
// that Improve Sparkle "is DELIBERATELY never a member of any project's `agents` array". So an
// overlay that iterates its `agents` parameter silently skips the self row — and
// `AgentSidebar.tsx`'s own comment records the consequence as though it were a feature: the overlays
// "pass every other key through", so that row resolves to its RAW PTY status, overlay-free.
//
// That has now bitten twice, in two different overlays:
//   • `withObservedAttention` — the mount-independent verdict never reached the self row, so it read
//     gray for days while its agent was live. The signal was never missing: `src-tauri/src/pty.rs`
//     attaches a `nudger::Observers` entry for EVERY PTY spawn, so a verdict for `__sparkle_self__…`
//     was produced and then discarded by an array filter.
//   • `withBackgroundTaskGreen` — the green-while-delegating promotion, whose own header
//     (`engine/backgroundTaskFooter.ts`) names the Improve Sparkle agent as the case it exists for.
//     It has never once run on that row.
//
// Two instances is the evidence that this belongs in ONE derivation rather than being re-remembered
// per overlay. A per-overlay fix is one the NEXT overlay forgets, and this is a rule the founder has
// forbidden any instruction from overriding.
//
// ⚠️ THE FIX IS THE OVERLAY'S SET, NOT THE ROSTER'S. Do not "simplify" this by admitting the self row
// into `projectStore.projects[].agents` — `knownAgents.ts` is explicit that the roster stays the
// USER'S build agents, and persistence, reaping, worker rollups and the sidebar's ordering all
// iterate it. Widen what the overlays iterate instead.
import { isSparkleAgentId } from "../services/sparkleAgent";

/**
 * The ids one overlay must consider: every roster id, plus any Sparkle-namespace id that `evidence`
 * has something to say about.
 *
 * `evidence` is whatever keyed collection that overlay is reasoning over — the observed-attention
 * readings, the live status map, a registry snapshot. Only its KEYS are read. Passing the collection
 * the overlay already holds is what keeps this honest: a row is admitted because there is a fact
 * about it, never merely because it could exist.
 *
 * ONLY the Sparkle namespace is admitted. A foreign id in `evidence` that is in no roster is not a
 * row on this screen, and inventing one would leak another window's agents into this one's overlay.
 *
 * Roster ids come FIRST and the self row is appended only if absent, so a window that DOES carry the
 * self row in `agents` yields it exactly once and in roster order.
 */
export function overlaidRowIds(
  agents: ReadonlyArray<{ id: string }>,
  evidence: Readonly<Record<string, unknown>>,
): string[] {
  const ids = agents.map((a) => a.id);
  const seen = new Set(ids);
  for (const id of Object.keys(evidence)) {
    if (!seen.has(id) && isSparkleAgentId(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
