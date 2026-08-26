// Pure decision logic for the close-agent Ship/Save/Discard flow. Kept React/IO-free so the
// "should closing this agent prompt, or just tear it down?" rule is unit-tested in isolation; the
// modal + lifecycle shell-outs live in components/AgentSidebar.tsx + CloseAgentPrompt.tsx.
import { stageIndex, type WorkflowStageId } from "./workflowStage";
import { firstVisibleAgentId } from "./agentOrdering";
import type { WorkMode } from "./workMode";
import type { BranchStatus } from "../services/branchStatus";
import type { AgentKind } from "../types";

/** What closing an agent should actually do.
 *
 *  Three outcomes, and the split exists because "prompt or don't" could not express the two
 *  genuinely different reasons to stop and ask:
 *   - `work-at-risk-prompt` — the Ship/Save/Discard choice. Something UNMERGED could be lost.
 *   - `retirement-confirm`  — the work already landed; what is at stake is the FEEDBACK RECORD and
 *                             the founder's standing instruction that he confirms removals himself.
 *   - `silent`              — nothing at risk and nothing to confirm; tear it down.
 *  Keeping them distinct matters downstream: the two prompts say different things, and the machine
 *  close paths may proceed through neither. */
export type CloseDecision = "silent" | "work-at-risk-prompt" | "retirement-confirm";

/** Everything the close decision reads about the agent's retro step.
 *
 *  Deliberately a bare boolean rather than the `RetroReceipt` itself: this function decides WHETHER
 *  to stop, not what to say when it does. The dialog reads the receipt for its wording; letting the
 *  decision see the receipt's fields would invite a rule like "excused closes silently", which is
 *  exactly the silent skip the founder asked to eliminate. */
export interface CloseRetroState {
  /** Has this agent completed the retro step (captured, excused, or a recorded human override)?
   *
   *  FAIL-CLOSED: `false` is also what "we have not been told" must produce — see
   *  engine/retroReceiptTypes.retroSettled. There is no `undefined` here on purpose; the caller
   *  collapses "no receipt" to `false` at the boundary so this function cannot be handed a third
   *  state it might treat as permission. */
  settled: boolean;
}

/**
 * Decide what closing this agent should do.
 *
 * ── WHAT CHANGED, AND WHY IT IS THE WHOLE BEAD ───────────────────────────────────────────────────
 * This used to be `shouldPromptOnClose`, and its third clause read:
 *
 *     if (stageIndex(stage) >= stageIndex("merged")) return false;   // "safe to close silently"
 *
 * That is true about the CODE — landed work cannot be lost by closing the row — and it was the
 * only thing the function was asked about. But it made the merged and shipped rows the one
 * population that vanished with no prompt of any kind, which is precisely the population the
 * founder was looking at when he said *"there are a number of agents showing as ships to production
 * where they should probably be closed. I want to make sure that they have all provided the retro
 * feedback before they get closed"* and *"the build agent shouldn't be removed from the build list
 * until I, as the human, confirm that."*
 *
 * So a landed build agent now returns `retirement-confirm` — ALWAYS, settled or not. The receipt
 * does not decide whether to ask; it decides what the dialog says (a recommendation versus a
 * request). Making a settled retro close silently would satisfy the retro half of his ask and
 * discard the other half, which was the explicit one.
 *
 * ── ORDERING: THE LANDED ARM IS FIRST, AND THAT HAS A COST (roborev 58742) ───────────────────────
 * This block used to claim work-at-risk was checked first. IT IS NOT, and the difference is not
 * academic: a build agent at `merged`/`shipped` with a DIRTY worktree or unpushed follow-up commits
 * returns `retirement-confirm`, never `work-at-risk-prompt`. `resolveStage` does not regress a
 * merged row below its git-derived stage, so post-merge edits keep it landed — this is a normal
 * state, not a corner.
 *
 * Kept in this order because the alternative is worse. Sending a dirty landed row to
 * Ship/Save/Discard tears it down with no retirement confirm at all, which is exactly the silent
 * skip this bead exists to close, and the founder's instruction ("shouldn't be removed from the
 * build list until I, as the human, confirm that") is unconditional.
 *
 * WHAT HAPPENS TO THE DIRTY FILES, plainly: nothing here saves them, and the retirement dialog as
 * written says the work landed — which is true of the CODE and misleading about the WORKTREE. The
 * remedy belongs in the dialog, not in this ordering: `RetireAgentConfirm` should read
 * `BranchStatus` and name the uncommitted files (`dirtyFiles` is already a capped preview) before
 * offering to remove the row. Tracked as bead `sparkle-jcux2`. Below `merged` the old rules are
 * unchanged and work-at-risk does win, because there nothing has landed to confirm.
 */
export function closeDecision(
  kind: string,
  stage: WorkflowStageId,
  bs: BranchStatus | undefined,
  retro: CloseRetroState,
): CloseDecision {
  // Workers have their own "merged → close?" nudge and report to an orchestrator, not to the build
  // list; think/shell have no worktree and no branch. None of them is a row the founder retires.
  if (kind !== "build") return "silent";

  // `merged_local`, NOT `merged` (knightwatch 5204094441#3). A no-remote "Ship it" MERGES the branch
  // into local main and stops there — the work has landed, which is the entire trigger for this gate.
  // Keying on `merged` (origin) meant the dialog opened once, from the ship handler's own fresher
  // `outcome.landed`, and then never again: dismiss it and the NEXT close re-asks this function,
  // which reads a clean tree 0 ahead and answers `silent`. The row vanished with no confirm, through
  // the gate rather than around it.
  //
  // That is a different question from `hasUnmergedCommittedWork`, which deliberately counts
  // `merged_local` as still-unmerged (it needs you to get it to ORIGIN). Both are right: it needs a
  // push, and it also already landed, so retiring the row is the founder's call and not ours.
  if (stageIndex(stage) >= stageIndex("merged_local")) {
    // `retro` is read here ONLY so this function has a reason to receive it and so the type makes
    // the caller resolve it — the outcome is the same either way, by design (see above). Kept
    // explicit rather than dropping the parameter, because the next person WILL ask "shouldn't a
    // settled agent close silently?" and the answer needs to live at the branch, not in a header.
    void retro.settled;
    return "retirement-confirm";
  }

  // Status not yet polled (undefined) ⇒ we can't rule out work at risk, so err toward the choice
  // rather than a silent teardown that could discard uncommitted changes. The undefined window is
  // sub-second after open (the poll sets it immediately), so this rarely surfaces a needless prompt.
  if (!bs) return "work-at-risk-prompt";
  // SAFETY side of sparkle-xk3x, and the OPPOSITE call from runtimeStore's attribution gate. A
  // worktree parked on another branch still physically holds whatever was uncommitted when it
  // was moved — parking carries those files along. So a parked tree is work we cannot rule out,
  // exactly like the `!bs` case above: prompt rather than tear down. Never suppress `dirty` here
  // on the grounds that it "belongs to another branch" — the files are real and deleting the
  // worktree destroys them.
  if (bs.worktreeOnBranch === false) return "work-at-risk-prompt";
  return bs.ahead > 0 || bs.dirty ? "work-at-risk-prompt" : "silent";
}

/**
 * What tearing down this agent's CHECKOUT would destroy, as three distinct answers.
 *
 * ── WHY THIS EXISTS: THE RETIREMENT DEADLOCK (bead sparkle-plxhx) ────────────────────────────────
 * The worker teardown guard used to ask one boolean — "is there uncommitted work?" — and answered it
 * with `bs.dirty || bs.worktreeOnBranch === false`, collapsing "we cannot tell" into "there is dirt".
 * That is defensible as a DEFAULT and indefensible as a PERMANENT state, and on 2026-08-08 it
 * deadlocked the founder's whole fleet: seven finished workers could not be retired, capacity sat at
 * 85 against a ceiling of 80, and no new agent could start.
 *
 * Both halves of that expression were wrong for the population it caught:
 *
 *  - `worktreeOnBranch === false` is TRUE FOR EVERY WORKER THAT NAMED ITS BRANCH DESCRIPTIVELY.
 *    `resolve_agent_branch` reports it whenever the minted `sparkle/agent-<id>` ref still exists
 *    while the tree sits elsewhere — i.e. after the `git checkout -b <topic>` that AGENTS.md
 *    actively encourages. Measured on the founder's machine: all six surviving deadlocked worktrees
 *    were on names like `pr1380` and `sparkle-k-esc`, and all six were `git status --porcelain`
 *    EMPTY. Nothing the worker could do would clear it — the founder restarted all seven and told
 *    them to commit, and nothing changed, because there was nothing to commit.
 *  - `!bs` (no reading at all) is PERMANENT once `runtimeStore`'s `deadWorktrees` latch fires: a
 *    removed worktree is never polled again, so `branchStatus[id]` stays `undefined` for the app's
 *    lifetime. The seventh worker was in exactly that state — its worktree directory was already
 *    gone, so there was no checkout left to lose, and it was refused on the grounds that its
 *    non-existent checkout might contain work.
 *
 * ── THE RULE, AND WHY `dirty === false` IS A POSITIVE READING ────────────────────────────────────
 * `dirty` is a porcelain read of the DIRECTORY, not of the branch — `git status --porcelain` run
 * inside the worktree. So `false` means "there are no uncommitted files in this directory", and that
 * is true whichever branch happens to be checked out into it. Parking cannot make an empty tree
 * non-empty. Crucially, a FAILED read can never present as `false`: `DirtyReading::read` propagates
 * the git error with `?` and the whole status read becomes an `Err`, which reaches this layer as no
 * reading at all (`undefined`) rather than as a clean one. A missing tree returns `dirty: false`
 * deliberately — there is nothing there to hold anything.
 *
 * That is the same precedence `uncommittedWorkEvidence` (engine/workflowStage.ts) adopted on
 * 2026-08-06 for the ATTRIBUTION question, for the same measured reason. This is the SAFETY twin it
 * should have got at the same time; leaving the two apart is the widened-rule/silent-conflict shape
 * where one copy of a rule is corrected and its sibling quietly keeps the old, narrow answer.
 *
 * ── WHAT IS DELIBERATELY UNCHANGED ───────────────────────────────────────────────────────────────
 * `dirty === true` still answers `"dirty"` EVEN WHEN THE TREE IS PARKED. Parking carries uncommitted
 * files along, so they are real, they are the user's, and the teardown's `--force` removal destroys
 * them with no salvage ref and no undo. That is the guard this function exists to preserve, and no
 * caller may retire past it without an explicit discard confirmation.
 *
 * The three answers, and who may act on them:
 *  - `"dirty"`   — real files at risk. Refuse; only an explicit discard confirmation overrides.
 *  - `"clean"`   — provably nothing at risk. Retire.
 *  - `"unknown"` — we genuinely could not read it. Refuse, but SAY SO HONESTLY and let an operator
 *                  who can see the tree override it. The old code reported this case as a false
 *                  claim that changes existed, which is what made the deadlock undebuggable.
 */
export type WorktreeRisk = "dirty" | "clean" | "unknown";

/** Classify a branch-status reading into {@link WorktreeRisk}. Pure; see the type for the reasoning. */
export function worktreeRiskOf(bs: BranchStatus | undefined): WorktreeRisk {
  // No reading at all — an unpolled agent, a latched-dead worktree, or a git read that errored.
  // Genuinely unknown, and reported as such rather than dressed up as dirt.
  if (bs === undefined) return "unknown";
  // Real uncommitted files. Parked or not, they are destroyed by the teardown. The guard holds.
  if (bs.dirty) return "dirty";
  // A porcelain read of the directory came back empty. `worktreeOnBranch` is NOT consulted here:
  // attribution ("whose dirt is this?") is only ever a question about dirt that exists.
  return "clean";
}

/** Whether closing an agent should pop the Ship/Save/Discard choice.
 *
 *  Now a thin projection of `closeDecision` so the two can never disagree. Kept as its own export
 *  because it is the question the Ship/Save/Discard modal itself asks, and because several callers
 *  and tests name it — but it is NO LONGER the whole close policy, and a caller that treats a
 *  `false` here as "safe to tear down" is now wrong. Use `closeDecision`. */
export function shouldPromptOnClose(
  kind: string,
  stage: WorkflowStageId,
  bs: BranchStatus | undefined,
): boolean {
  // Any `settled` value gives the same answer for this projection: the retirement arm returns
  // `retirement-confirm`, which is not `work-at-risk-prompt` either way.
  return closeDecision(kind, stage, bs, { settled: false }) === "work-at-risk-prompt";
}

/** Minimal agent shape `selectionAfterClose` reads. */
export type CloseSelectionAgent = {
  id: string;
  kind: AgentKind;
  parentId: string | null;
};

/**
 * Decide selection after a close. `removedRootId` (and its workers, enumerated from the
 * pre-removal `agentsBefore`) just left the store; `agentsAfter` is the post-removal list.
 *
 *  - If the agent that was OPEN (`selectedId`, or one of its workers) was torn down, re-point
 *    selection at the first visible row of the current work `mode` — or `null` (the blank
 *    first-load state with the "+ New Build Agent" CTA) when no rows remain. `removeAgent`'s own
 *    fallback is raw `agents[0]` (insertion order); this keeps the pane and sidebar in agreement.
 *  - If a row OTHER than the open one was closed, selection stays put (`reselect: false`).
 */
export function selectionAfterClose<T extends CloseSelectionAgent>(
  removedRootId: string,
  selectedId: string | null,
  agentsBefore: readonly T[],
  agentsAfter: readonly T[],
  mode: WorkMode,
  // The genuinely-first VISIBLE row, supplied by the caller when it knows the rendered ladder order
  // and the active status filter (the sidebar does; other callers don't). Falls back to the first
  // top-level agent in array order. Threading it as a value — rather than re-deriving an ordering
  // preference in here — is what keeps this helper pure and lets the sidebar guarantee selection
  // never lands on a row the user has filtered out of sight.
  preferredNext?: string | null,
): { reselect: boolean; next: string | null } {
  const removed = new Set<string>([removedRootId]);
  for (const a of agentsBefore) if (a.parentId === removedRootId) removed.add(a.id);
  if (!selectedId || !removed.has(selectedId)) return { reselect: false, next: selectedId };
  // Only trust `preferredNext` if that agent actually survived the close.
  const survives = preferredNext != null && agentsAfter.some((a) => a.id === preferredNext);
  return {
    reselect: true,
    next: survives ? preferredNext : firstVisibleAgentId(agentsAfter, mode),
  };
}
