// THE ADVISOR'S PUBLIC SURFACE — two functions, and the split between them is the design.
//
//   • {@link advisorBriefFor} is SYNCHRONOUS and returns a string. `seedDraft` is on the Build It
//     click path and cannot await; the findings it folds in are whatever a previously-dispatched
//     pass has already delivered.
//   • {@link advisorHandoffHook} is fire-and-forget. It records the terminal verdict for THIS
//     handoff and, when nothing is held yet, dispatches a pass whose answer reaches the NEXT one.
//
// Everything else in this directory is either pure (`spendGate`, `model`, `findings`, `config`) or a
// seam (`deps`, `latch`, `watcher`). Nothing outside this file should import `pass.ts` directly.
import { log } from "../../logger";
import { appendFindingsToBrief, consumeVerdict, hasHighFinding, heldVerdict } from "./findings";
import { primeAdvisorConfig, productionDeps } from "./deps";
import { ensureAdvisorVerdict, type AdvisorPassArgs, type AdvisorPassDeps } from "./pass";
import { ensureAdvisorWatcher, watchAdvisorPass } from "./watcher";

export { ADVISOR_REVIEWED_LABEL, ADVISOR_SKIPPED_LABEL } from "./pass";
export { clearAdvisorLatch } from "./latch";
export { resetHeldVerdicts } from "./findings";
export { resetAdvisorPassState } from "./pass";
export { primeAdvisorConfig } from "./deps";

/**
 * Fold this epic's ADVISOR FINDINGS into a seed prompt, or return it UNCHANGED.
 *
 * SYNCHRONOUS, and that is a constraint rather than a convenience — see `./findings` for the
 * measurement (twelve orchestrators launched with an empty prompt) that makes the argv path the only
 * delivery channel, and `sendToBuild.seedDraft` for why it has to be attached before the mount.
 *
 * Returns the prompt untouched whenever no verdict is held: on a first handoff, while a pass is
 * still running, and on every path where the pass could not run at all. That is the failure contract
 * from `judge.rs` — an advisor that cannot run PAINTS NOTHING, because a reassuring sentence about a
 * review that did not happen is worse than no advisor.
 */
export function advisorBriefFor(epicId: string, seed: string): string {
  try {
    // CONSUMED, not read. One epic is handed off many times (Start, Build It,
    // `promote_plan_to_build`, the sweep), and a plain read re-injects the same findings block into
    // every later seed — telling an orchestrator about a review a previous orchestrator already
    // acted on. See `consumeVerdict` for why the two channels are tracked separately.
    return appendFindingsToBrief(seed, consumeVerdict(epicId, "seed"));
  } catch (e) {
    // The seed must reach the orchestrator whatever this feature does. A throw here would take out
    // the mission itself, which is a far larger failure than a missing advisory block.
    log.warn("advisor", "could not fold advisor findings into the seed brief", e);
    return seed;
  }
}

/**
 * THE HANDOFF HOOK: record this handoff's TERMINAL verdict, and watch whatever it dispatched.
 *
 * ONE dispatch per handoff, at most. `ensureAdvisorVerdict` owns the whole decision — held verdict →
 * `advisor:reviewed`; nothing held → run the pass once and record `advisor:skipped` naming why (a
 * gate refusal, or "dispatched but had not answered when the orchestrator bound"). It hands the
 * dispatch back on its record so this can register the watch without re-running anything.
 *
 * FIRE AND FORGET, exactly like `prepareHandoff`'s `PROMOTED_LABEL` write and for the same reason:
 * that function is synchronous and on the click path for the board's Start button, and blocking a
 * handoff the user just asked for on a `bd` write — against a single-writer store another worktree
 * may hold the lock on — would stall the UI for the length of that queue.
 *
 * NEVER THROWS and never rejects. Callers `void` it.
 *
 * `deps` is injectable so the wiring test can drive THIS function — the production call site — rather
 * than a hand-built copy of it. See `./deps` for why that matters here specifically.
 */
export async function advisorHandoffHook(
  args: AdvisorPassArgs,
  deps: AdvisorPassDeps = productionDeps(),
): Promise<void> {
  try {
    // ══ PRIME THE CONFIG FIRST — WITHOUT THIS THE KILL SWITCH IS INERT ═════════════════════════
    //
    // `pass.ts` reads `[advisor]` SYNCHRONOUSLY (`config: () => AdvisorConfigView`): it must not add
    // another await before the spend gate, and a config read that failed there would have to invent
    // an answer — which for a flag that ships ON means inventing permission. So the value is
    // refreshed out of band, here, and read from the cache.
    //
    // This call is the whole switch. Without it `cachedConfig` stays at
    // `resolveAdvisorConfig(undefined)` forever, so `[advisor].enabled = false` cannot stop a pass
    // and `[advisor].model` is never honoured — a documented master switch that does nothing, for a
    // feature that ships ON and dispatches a $5/$25-per-Mtok model. `advisorHandoffHook.wiring.test`
    // drives THIS function with `getConfig` returning `enabled: false` and asserts the pass REFUSES,
    // so deleting this line goes red rather than silently re-arming the feature.
    //
    // One `get_config` per handoff is cheap; a stale kill switch is not. It never throws — a failed
    // read keeps the last value the backend actually said.
    await primeAdvisorConfig(args.projectPath);
    const record = await ensureAdvisorVerdict(deps, args, heldVerdict);
    if (!record.dispatched) return;
    watchAdvisorPass({
      taskId: record.dispatched.taskId,
      epicId: args.epicId,
      projectPath: args.projectPath,
      model: record.dispatched.model,
    });
    ensureAdvisorWatcher();
  } catch (e) {
    log.error("advisor", "the advisor handoff hook crashed", e);
  }
}

/**
 * The ONE revision round's input: the advisor's HIGH findings, phrased for the planner.
 *
 * ══ WHY ONLY `high`, AND WHY EXACTLY ONE ROUND ══════════════════════════════════════════════════
 *
 * `decomposeEpic` is the single moment a plan can still be revised before any bead is written, and
 * the round there is bounded at ONE deliberately — `.roborev.toml` measured the fix→review→fix loop
 * over 6,281 reviews and it does not converge (61.6% fail on round 1, then a 40-48% plateau through
 * the fourteenth). Restricting the trigger to `high` is the second half of that bound: a medium
 * finding is worth telling the ORCHESTRATOR about (it rides the seed brief) but is not worth
 * re-running the planner over.
 *
 * READS A VERDICT ALREADY DELIVERED — it never dispatches. Returns `null` when nothing is held or
 * nothing is `high`, which is the ordinary case, so a decompose that runs before any pass has
 * answered proceeds exactly as it did before this feature existed.
 *
 * NEVER THROWS: a second opinion that cannot be obtained must not cost a decomposition.
 */
export async function advisorRevisionNote(epicId: string): Promise<string | null> {
  try {
    // CONSUMED on its own channel, which is what makes "exactly ONE revision round" a property of
    // the VERDICT rather than of a single `decomposeEpic` call. A sweep retry after a cleared
    // `decompose-failed` badge would otherwise spend another planner call re-litigating findings the
    // previous round already addressed.
    const verdict = consumeVerdict(epicId, "revision");
    if (!hasHighFinding(verdict) || !verdict) return null;
    const high = verdict.findings.filter((f) => f.severity === "high");
    return [
      "── A SECOND MODEL REVIEWED THIS PLAN AND RAISED THE FOLLOWING ──────────────────────────",
      `Reviewer: ${verdict.model} (research task ${verdict.taskId}). It did NOT rewrite the plan —`,
      "these are its findings, and revising the plan is YOUR call. Address what you agree with and",
      "re-plan; you get ONE revision round, so make it count rather than deferring.",
      "",
      ...high.flatMap((f) => {
        const lines = [`[HIGH] ${f.lens}: ${f.summary}`];
        if (f.evidence?.trim()) lines.push(`   evidence: ${f.evidence.trim()}`);
        return lines;
      }),
      "───────────────────────────────────────────────────────────────────────────────────────",
    ].join("\n");
  } catch (e) {
    log.warn("advisor", "could not build the revision note", e);
    return null;
  }
}
