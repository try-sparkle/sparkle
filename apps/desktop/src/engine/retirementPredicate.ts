// MAY THE CONCIERGE RETIRE THIS AGENT UNATTENDED? — the pure half of the `retire_agent` verb.
//
// ── WHY A NEW VERB AND NOT A LOOSER `close_agent` ────────────────────────────────────────────────
// Two independent gates refused every programmatic close, and only one of them was designed:
//
//  1. `conciergeTools/policy.ts` classes `close_agent` as `disruptive`, which derives to `ask`. So
//     every concierge close came back `needs-approval` and parked a card nobody was awake to click —
//     including closes the app already considers provably safe. That reclassification was written to
//     stop the concierge killing work IN FLIGHT; it swept up the finished population as collateral.
//  2. `closeBuildAgent` refuses `needs-human-confirm` for any build agent whose work LANDED (bead
//     sparkle-0l9xk — the concierge closed three landed agents on its own judgement and each left
//     with its retro unread).
//
// The founder's instruction on 2026-08-12 was *"no i absolutely do not want close_agent to be human
// only. let's fix that so you can close agents that need to be closed"* — said with the fleet at ~78
// of 81 slots and a pile of finished agents holding them.
//
// `close_agent` is UNCHANGED by this module: it keeps its `ask` tier and both refusals, so the
// sidebar ×, the phone tap and the green button cannot regress. `retire_agent` is a separate, NARROWER
// door. Choosing it can only ever be more restrictive than choosing `close_agent`, so nothing is
// escapable by picking this name — which is the objection policy.ts's header raises about any gate
// keyed on a tool name, and the reason it does not apply here.
//
// ── THE GOVERNING RULE ───────────────────────────────────────────────────────────────────────────
//
//      NO CACHED OR DERIVED STATUS EVER AUTHORIZES A RETIREMENT. ONLY A LIVE READ DOES.
//
// This is the founder's own call, generalized. He was burned twice on 2026-08-12 by agents that read
// `quota-blocked` while actually mid-work, and asked that a quota reading never authorize a close on
// its own. Three separate facts in this codebase say the same thing, which is why it is the
// organizing rule here rather than a quota special case:
//
//  • `runtimeStore.status` is WINDOW-LOCAL and never persisted. After a relaunch, or for a project no
//    window hosts, every agent reads `undefined` (engine/retirementReadiness.ts).
//  • `runtimeStore.branchStatus` is a 30s cache with two states that NEVER recover on their own —
//    the latched `deadWorktrees` set and never-mounted rows (conciergeTools/lifecycle.ts).
//    `spin_down_worker` already learned this and re-reads git at the moment of decision.
//  • `engineRegistry.quotaBlockForAgent` returns `undefined` for TWO different reasons — no wall, and
//    no engine registered in this window — and is deliberately fail-OPEN. It cannot authorize.
//
// Hence every input below is documented as a LIVE reading. This module is pure so the rule is
// testable as arithmetic; the live reads themselves live in conciergeTools/lifecycle.ts.
//
// ── AND WHY "WE COULD NOT TELL" REFUSES, WITHOUT DEADLOCKING ─────────────────────────────────────
// Absence of evidence is never evidence here — `unknown` refuses everywhere it appears. That
// direction has its own well-documented failure mode: on 2026-08-08 a guard that collapsed "cannot
// tell" into "there is dirt" deadlocked the whole fleet at 85 agents against a ceiling of 80, with no
// action available to clear it (bead sparkle-plxhx). A fail-safe default became a fail-PERMANENT one.
//
// What keeps this from repeating is that every `unknown` arm has a REMEDY the concierge can actually
// perform: go and take the live reading. The refusals name it. That is the difference between a
// cautious gate and a locked door.
import type { AgentKind } from "../types";
import type { WorktreeRisk } from "./closeAgent";

/** How fresh a terminal excerpt must be to count as evidence about the PRESENT. */
export const EVIDENCE_FRESHNESS_MS = 5 * 60_000;

/**
 * Is the agent producing output right now?
 *
 * `unknown` is a real and common answer, not an error — see the header on why `runtimeStore.status`
 * reads `undefined` for whole projects. It refuses, with the remedy named.
 */
export type LiveActivity = "working" | "quiet" | "unknown";

/** What the concierge claims about an agent it says is dead, plus the evidence for it. */
export interface DeadClaim {
  /** A verbatim excerpt of what was on the agent's screen. */
  evidence: string;
  /** Epoch ms the excerpt was READ — not the epoch of whatever it describes. */
  observedAt: number;
  /**
   * Which tier of `conciergeTools/terminal.ts` produced it.
   *
   * ONLY THE LIVE SCROLLBACK IS A STATEMENT ABOUT THE PRESENT. That module returns four tiers,
   * freshest first — live xterm scrollback, then `attentionScreen` (a SNAPSHOT, and its own header
   * says so), then SQLite history, then the transcript. The lower three describe a moment that has
   * passed, which is exactly how a stale reading came to outrank a working agent.
   */
  source: string;
}

/** The live readings a retirement decision is made from. Every one of them is read AT the decision. */
export interface RetirementInputs {
  kind: AgentKind;
  /** LIVE `git status --porcelain` of the worktree — NEVER `worktreeRiskOf(cachedBranchStatus)`. */
  worktreeRisk: WorktreeRisk;
  /**
   * `engine/workflowStage.unlandedWorkEvidence` over LIVE readings: is there committed work that
   * never reached main? `undefined` means nothing was read.
   *
   * REUSED RATHER THAN RE-DERIVED, because the obvious test is wrong: `ahead` NEVER returns to zero
   * after a squash or rebase merge (it is `rev-list --left-right --count`, so it only reaches 0 once
   * the branch TIP is an ancestor of the base). `merged` and `shipped` rows therefore carry a
   * non-zero count forever, and a predicate keyed on the count would refuse to retire exactly the
   * population this verb exists for. That function already yields to direct reachability
   * (`landed` / `inOriginMain` / `inLocalMain`) for this reason.
   */
  unlanded: boolean | undefined;
  /**
   * WHICH branch the `unlanded` reading above was taken on, and how far ahead it read — the
   * evidence a human needs to re-run the check and get the SAME answer.
   *
   * ⚠️ THE MEASURED BRANCH IS NOT ALWAYS THE ONE CHECKED OUT. `unlanded` is derived from the agent's
   * resolved branch (Rust `resolve_agent_branch`, surfaced as `BranchStatus.branch`), and a worktree
   * can be parked on, or renamed onto, something else entirely. Measured 2026-08-31 (bead
   * `sparkle-c68xl5`): a refusal fired over two real unlanded commits on the agent's own branch
   * while the operator, standing in its worktree, read HEAD as an ancestor of `origin/main` and
   * reported the refusal as a false positive. Both readings were right about different branches and
   * the sentence named neither, so nobody could tell which — and the row cost a fleet slot until a
   * human retired it by hand.
   *
   * ⚠️ ALL THREE FIELDS MUST COME FROM ONE READING OF ONE BRANCH, and this is not a tidiness rule —
   * mixing them re-creates the exact false positive the clause exists to close (roborev 73884).
   * `WorkflowState.aheadOfBase` is FOLDED ACROSS NESTED ADOPTED WORKTREES — Rust takes the MAX over
   * the subtree (`worktree.rs`, "the most outstanding work anywhere in the subtree") — and that fold
   * is also what clears `inOriginMain` and makes `unlanded` fire. Pair that count with the agent's
   * OWN branch name and the sentence reads "1 commit on “sparkle/agent-<id>”" for a branch that is
   * 0 ahead and IS an ancestor of `origin/main`: the operator re-runs the check, gets an empty list,
   * and concludes false positive again — now with a named branch backing the wrong conclusion, which
   * is worse than the sentence that named nothing. So the count travels with `BranchStatus`, beside
   * the branch `BranchStatus` measured it on.
   *
   * Optional, and every arm of it is: `BranchStatus.branch` is itself optional so a Rust build
   * predating the field deserializes to `undefined`, which means "this build cannot tell you" and
   * must render as NOTHING — never as a blank or guessed branch name.
   */
  measuredOn?: { branch?: string; ahead?: number; base?: string } | null;
  /** LIVE read of whether the agent is producing output. See {@link LiveActivity}. */
  liveActivity: LiveActivity;
  /** The concierge's own stated reason. Recorded verbatim in the audit trail. */
  reason: string;
  /**
   * Set when the reason claims the agent is quota-walled, crashed or otherwise dead.
   *
   * A CLAIM OF DEATH RAISES THE BAR, IT DOES NOT LOWER IT. Nothing here is unlocked by asserting an
   * agent is dead — the tree and branch requirements are unchanged either way. What this does is
   * force the claim to be backed, so the founder can check it afterwards against the excerpt the
   * concierge actually read.
   */
  deadClaim?: DeadClaim | null;
  now: number;
}

/** Why a retirement was refused. Machine-readable; the sentence travels alongside. */
export type RetirementRefusal =
  | "not-retirable-kind"
  | "uncommitted-work"
  | "status-unknown"
  | "unlanded-work"
  | "unlanded-unknown"
  | "agent-busy"
  | "activity-unknown"
  | "reason-required"
  | "stale-evidence";

export type RetirementVerdict =
  | { ok: true }
  | { ok: false; refusal: RetirementRefusal; message: string };

/** Kinds that own a worktree, and so can be retired at all. A `shell` has no branch of its own. */
function retirableKind(kind: AgentKind): boolean {
  return kind === "build" || kind === "worker";
}

/**
 * The "…and here is where I read that" half of the `unlanded-work` sentence.
 *
 * A REFUSAL A HUMAN CANNOT RE-RUN IS A REFUSAL THEY WILL CALL A BUG. This is the same remedy
 * `BranchStatus.branch` was put on the wire for (sparkle-pgkbn4 — "the row had no way to say what it
 * counted"), spent on the one surface that actively asks somebody to go and check with git. So where
 * it can, it prints the COMMAND rather than a number: `git log <base>..<branch>` is checkable, and a
 * bare count is only an assertion.
 *
 * Four arms, and the empty one is deliberate:
 *   • name + positive count + base → the command and its expected answer;
 *   • name + positive count       → the count on that branch, with no base to reproduce it against;
 *   • name alone → the name. A non-positive `ahead` is not "nothing outstanding" here — a squash or
 *     rebase land leaves that counter at a number this rung must not quote (see `unlanded`) — so an
 *     unread count is simply not shown rather than rendered as `0 commits`;
 *   • no name → NOTHING. An absent `BranchStatus.branch` means "this build cannot tell you", and a
 *     blank or guessed branch name is worse than the sentence that never claimed one.
 *
 * ⚠️ WHEN THE BASE IS NAMED IT IS THE PROJECT'S DEFAULT BRANCH, while Rust counted against
 * `origin/<default>` whenever that ref exists. The two differ only while the local base LAGS its
 * remote, and then the local count is the LARGER one — so a human re-running the printed command
 * sees at least as many commits as the message claimed. That is the safe direction for this
 * sentence: it can under-claim, never over-claim, so the reading can never look manufactured.
 */
function unlandedEvidenceClause(m: RetirementInputs["measuredOn"]): string {
  const branch = m?.branch?.trim();
  if (!branch) return "";
  const ahead = m?.ahead;
  const base = m?.base?.trim();
  const counted = typeof ahead === "number" && Number.isFinite(ahead) && ahead > 0;
  // The trailing clause is the load-bearing half for the case this was built from: without it a
  // human checks the branch their worktree happens to have checked out, gets the opposite answer,
  // and concludes the refusal is false.
  const measured = `That is the branch this reading was measured on, which is not always the one checked out in the agent's worktree`;
  if (counted && base) {
    return `: “${base}..${branch}” holds ${ahead} commit${ahead === 1 ? "" : "s"}. ${measured}`;
  }
  if (counted) {
    return `: ${ahead} commit${ahead === 1 ? "" : "s"} on “${branch}”. ${measured}`;
  }
  return `: measured on “${branch}”. ${measured}`;
}

/**
 * May the concierge retire this agent, unattended and without asking?
 *
 * ── NO CAP, AND THAT IS DELIBERATE ───────────────────────────────────────────────────────────────
 * The founder's explicit decision on 2026-08-12, matching the "no cap, trust the concierge" call
 * already recorded for research dispatch. DO NOT ADD A PER-HOUR OR PER-TURN LIMIT HERE — it was
 * considered and declined by name.
 *
 * The reasoning, so it is not re-litigated: the safety of this operation comes from the predicate,
 * not from a counter. A retirement that satisfies every rung below destroyed nothing — the tree was
 * clean, the work had landed, the agent was quiet. That is as true of the fiftieth as of the first,
 * and a cap would only ever stop the app from finishing a job it had already proven safe. A counter
 * would buy protection against a BUG IN THIS FUNCTION, and the honest defence against that is the
 * paired tests and the audit record, not a magic number that makes a bug slower.
 */
export function mayRetire(i: RetirementInputs): RetirementVerdict {
  if (!retirableKind(i.kind)) {
    return refuse(
      "not-retirable-kind",
      `A ${i.kind} agent has no worktree or branch of its own, so retiring it is a different operation with different consequences.`,
    );
  }

  // A REASON IS REQUIRED BEFORE ANY SAFETY READING IS CONSULTED, so a caller that cannot say why it
  // is retiring something is stopped before it can find out whether it would have been allowed to.
  if (i.reason.trim() === "") {
    return refuse(
      "reason-required",
      "I need to say why I'm retiring this agent — the reason goes on the permanent record the founder reads afterwards, so it can't be blank.",
    );
  }

  // ── THE TREE ────────────────────────────────────────────────────────────────────────────────────
  // Closing an agent removes its worktree in EVERY outcome, so uncommitted files are lost by ship,
  // save and discard alike. This is the only rung where real, unrecoverable data is at stake.
  if (i.worktreeRisk === "dirty") {
    return refuse(
      "uncommitted-work",
      "This agent has uncommitted changes in its worktree. Retiring it deletes that checkout, so those changes would be gone for good — it needs to commit first.",
    );
  }
  if (i.worktreeRisk === "unknown") {
    // NOT PHRASED AS A CLAIM ABOUT UNCOMMITTED FILES. Saying "it has uncommitted changes" about a
    // tree nobody could read is the false statement bead sparkle-plxhx was filed over.
    return refuse(
      "status-unknown",
      "I couldn't read this agent's worktree, so I can't tell whether it holds uncommitted changes — this is NOT a report that it does. I've stopped rather than guess.",
    );
  }

  // ── THE BRANCH ──────────────────────────────────────────────────────────────────────────────────
  if (i.unlanded === true) {
    return refuse(
      "unlanded-work",
      `This agent has committed work that never reached main${unlandedEvidenceClause(i.measuredOn)}. Retiring it keeps the branch, but nobody would be left finishing it — it should be shipped or saved first.`,
    );
  }
  if (i.unlanded === undefined) {
    return refuse(
      "unlanded-unknown",
      "I couldn't establish whether this agent's committed work has landed, so I can't rule out that retiring it would strand something. I've stopped rather than guess.",
    );
  }

  // ── THE PROCESS ─────────────────────────────────────────────────────────────────────────────────
  // Reached only once the tree is provably clean and nothing is unlanded, so NOTHING ON DISK is at
  // stake here. What this rung protects is the agent's turn in flight — the founder was burned twice
  // on 2026-08-12 by agents retired while mid-work, and an interrupted turn is a real cost even when
  // no file is lost.
  if (i.liveActivity === "working") {
    return refuse(
      "agent-busy",
      "This agent is still mid-exchange — producing output, or holding a question or approval open. Nothing of its work is at risk, but retiring it would cut off a turn in progress, so I've left it alone.",
    );
  }
  if (i.liveActivity === "unknown") {
    // THE REMEDY IS NAMED, which is what stops this from becoming the permanent refusal of
    // sparkle-plxhx. `runtimeStore.status` reads `undefined` for whole projects after a relaunch, so
    // this arm is common rather than exotic — and the concierge can always clear it by looking.
    return refuse(
      "activity-unknown",
      "I couldn't tell whether this agent is still working — its live status isn't readable from here, which happens for a whole project after a restart. Read its terminal and retry with what you saw.",
    );
  }

  // ── THE CLAIM ───────────────────────────────────────────────────────────────────────────────────
  if (i.deadClaim) {
    if (i.deadClaim.source !== "scrollback") {
      return refuse(
        "stale-evidence",
        `I'm claiming this agent is dead on a "${i.deadClaim.source}" reading, which describes a moment that has already passed. Only the live scrollback says anything about right now — that is exactly how a stale quota reading outranked two agents that were actually working.`,
      );
    }
    const age = i.now - i.deadClaim.observedAt;
    // A FUTURE-DATED READING IS ALSO REFUSED (age < 0). A clock that disagrees is not evidence, and
    // an unsigned comparison against the window would have let it through as "very fresh".
    if (age < 0 || age > EVIDENCE_FRESHNESS_MS) {
      return refuse(
        "stale-evidence",
        `The evidence I have that this agent is dead was read ${Math.round(age / 1000)}s ago, which is outside the ${Math.round(EVIDENCE_FRESHNESS_MS / 1000)}s window. Re-read its terminal and retry.`,
      );
    }
    if (i.deadClaim.evidence.trim() === "") {
      return refuse(
        "stale-evidence",
        "I'm claiming this agent is dead but carrying no excerpt of what was on its screen. The founder reads that excerpt to check the claim, so an empty one is not evidence.",
      );
    }
  }

  return { ok: true };
}

function refuse(refusal: RetirementRefusal, message: string): RetirementVerdict {
  return { ok: false, refusal, message };
}
