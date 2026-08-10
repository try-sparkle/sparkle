// finishedHeadCalm — a row the app has POSITIVELY DETERMINED is finished stops inheriting alarm.
//
// CASE 1 of bead sparkle-hpbkw. The founder, 2026-08-09: *"Why are agents like @Preview Work In A
// Browser and @Typing Never Wedges red dots? they don't seem to be blocked by me"*.
//
// Agent 6dc70c58 read status `idle`, `needsYou` FALSE, goal state `met`, and a stall verdict of
// `finished` whose own detail said *"Resting with no goal outstanding, no open PR, nothing unlanded
// and a clean worktree — genuinely done."* Every signal an agent or a script can read said DONE.
// The sidebar painted it red.
//
// ── THE ROOT CAUSE IS A DISAGREEMENT BETWEEN TWO MAPS ────────────────────────────────────────────
// `conciergeTools/terminal.getAgentStatus` derives `needsYou` from the RAW `runtimeStore.status`.
// The sidebar renders `effectiveStatus`, the overlay chain in `useAttentionNotifications`. Every
// overlay in that chain can only ADD red, and `getAgentStatus` cannot see any of them — so the two
// diverge BY CONSTRUCTION the moment an overlay fires, always in the same direction: the
// machine-readable surface reads calm, the pixel reads alarm. For a row whose stall verdict is
// `finished`, only the two worker bubbles can be the source (the rest either calm, de-escalate, or
// require a `stalled` verdict), so the red on that row was entirely INHERITED from a worker.
//
// ── WHY THIS MODULE IS NARROW, AND WHY THAT IS NOT A COMPROMISE ─────────────────────────────────
// The obvious fix is the general rule: `needsYou === false ⇒ never red`. That was implemented and
// wired, and it turned SEVEN pinned expectations red — including `publishedRollupAgreement.test.ts`'s
// stated *"head in motion + WAITING worker still asks"*, a folded head whose worker is sitting on a
// real question. Silencing that is the failure Sparkle's standing rule exists to prevent. It also
// demoted every raw `blocked` on the fleet and every stranded-worker red. That is a redesign and a
// product decision, and it was handed back rather than taken.
//
// What this module does instead is the INTERSECTION of the candidate rules — the part that is
// correct under every one of them, so it needs no decision to be safe:
//
//     a head we have POSITIVELY READ as finished, wearing a red that is not its own, is not an ask.
//
// "Positively read" is doing the work. `isFinished` must come from `agentStall`'s `finished`
// verdict, which is only returned when the git state was actually looked at — a row nobody polled
// answers `unknown`, and `unknown` demotes NOTHING here. That is the same evidence-not-inference
// default `agentStall.isStalled`, `rollupDot`'s null arm and `rowAttention`'s whole header describe:
// making a row calm on missing data is the mirror image of making it red on missing data, and both
// train the human to stop reading the colour.
//
// It cannot reach the seven pins above because none of those heads is finished — the in-motion case
// is `working`, and a head with live workers under it is not resting. The default is `false`, so a
// caller that has no stall evidence to give gets exactly today's behaviour.
import { bandOfStatus } from "./buildSections";
import { needsAttention, type StatusMap } from "./attention";
import { LAPSED_STATUS } from "./stallEscalation";

/**
 * Should this row stop carrying an inherited alarm? Exported so the rule has ONE spelling — a test
 * or call site that re-stated it would be a second copy of the taxonomy, and a second copy of this
 * taxonomy is what has drifted twice already (see the `blocked` and `unmerged` notes in
 * packages/ui/tokens.ts).
 *
 * All three conjuncts are load-bearing:
 *   • the row must currently READ as an ask (otherwise there is nothing to demote);
 *   • the ask must not be its OWN (`needsAttention(own)` — a head asking on its own behalf is
 *     untouched by every line here, which is the safety property);
 *   • and we must have POSITIVELY read it as finished (`true`, never merely not-`false`).
 */
export function isFinishedHeadCalmed(
  published: string | undefined,
  own: string | undefined,
  finished: boolean | undefined,
): boolean {
  if (published === undefined) return false;
  if (bandOfStatus(published as never) !== "needs_you") return false;
  // An agent asking on its OWN behalf keeps its red, finished or not. Note `needsAttention`
  // (waiting/approval/errored/questions), not `isRedStatus` — `blocked` is red but is not an ask,
  // and a `blocked` head is not what this module is about either way.
  if (needsAttention(own as never)) return false;
  // POSITIVE evidence only. `undefined` means the git state was never read and `false` means it was
  // read and the row is NOT finished; neither earns the calmer reading.
  return finished === true;
}

/**
 * Demote the inherited red on every positively-finished head, to the amber `lapsed`.
 *
 * Pure, and in the same shape as every other overlay: returns the SAME reference when nothing
 * changes (no render churn) and never mutates the input.
 *
 * `own` MUST be the pre-bubble status map, not this function's output and not the published one.
 * Feeding it a bubbled map collapses the rule — a head wearing an inherited `approval` would read as
 * asking on its own behalf and nothing would ever be demoted — which is the identical trap
 * `rollupDotAccessor` documents at length on its `ownStatusOf` parameter.
 *
 * WHAT IS NOT HIDDEN, because this is a demotion and not a deletion: the WORKER keeps its own red on
 * its own row, and `engine/workerExpansion`'s peek line still names it under the folded head — the
 * surface the founder endorsed verbatim ("it just peaks the one that's red and needs me and that's
 * fine the way that it's working now"). Only the finished parent stops shouting.
 */
export function withFinishedHeadCalm<T extends { id: string }>(
  agents: readonly T[],
  published: StatusMap,
  own: StatusMap,
  isFinished: (id: string) => boolean | undefined,
): StatusMap {
  let out: StatusMap | null = null;
  const ensure = (): StatusMap => (out ??= { ...published });
  for (const a of agents) {
    if (!isFinishedHeadCalmed(published[a.id], own[a.id], isFinished(a.id))) continue;
    ensure()[a.id] = LAPSED_STATUS;
  }
  return out ?? published;
}
