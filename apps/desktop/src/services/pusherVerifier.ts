// THE RE-READ — the only impure half of verify-before-speak, and deliberately the dumbest.
//
// `pusherVerify` in `@sparkle/core` says WHICH facts a finding rests on and what a contradiction is
// allowed to change; all of that is arithmetic and is tested as arithmetic. This file answers ONE
// question per claim, from git and the GitHub API, at the moment the Pusher is about to speak. It
// decides nothing else. A judgement made here would be a second opinion about the same PR, invisible
// to the pure tests — the failure `pusherSnapshots` refuses for the same reason.
//
// ── THE ONE RULE ─────────────────────────────────────────────────────────────────────────────────
// `refuted` REQUIRES AN AFFIRMATIVE CONTRADICTION. Everything else — a probe that failed, a `gh`
// that is not authenticated, a truncated list, a goal kind no machine can answer, an agent whose
// repo we cannot locate — is `unreadable`, which licenses nothing.
//
// Read that as the fail-closed rule pointed at a different failure than usual. Elsewhere in the
// Pusher, fail-closed means "an absent input must never manufacture a CLAIM". Here it means an
// absent input must never manufacture a RETRACTION, because a retraction is silence and silence is
// what this whole feature exists to eliminate. Both are the same rule: only evidence moves anything.
//
// ── EVERY READ IS BATCHED PER SUBJECT, NOT PER CLAIM ─────────────────────────────────────────────
// Two claims about one agent (`agent-has-no-unlanded-work` and `goal-unmet`) cost ONE branch read and
// ONE workflow read between them, and every `pr-open` claim in a sweep shares one `gh pr list` per
// repo. This runs on the send path of a sweep that was about to interrupt the founder, which is rare
// — but a per-claim fan-out over a 100-PR fleet would be a hundred round-trips inside a tick.

import {
  claimKey,
  type ClaimVerdict,
  type ClaimVerdicts,
  type PusherClaim,
} from "@sparkle/core";
import { inferGoalVerify } from "@sparkle/core";
import type { AgentGoal } from "../engine/agentGoal";
import type { BranchStatus, WorkflowState } from "./branchStatus";
import type { PrRow } from "./openPrs";
import { unlandedWorkOf } from "./pusherSnapshots";
import { log } from "../logger";

/** A repository the verifier may ask about — one open project tab, flattened. */
export interface VerifyScope {
  projectId: string;
  /** `null` for a project with no checkout: never probed, so it contributes no answer either way. */
  rootPath: string | null;
}

/** Everything the re-read needs, injected so the rules below are testable without a running app. */
export interface PusherVerifierDeps {
  /**
   * Every repo whose open-PR list could answer a `pr-open` claim.
   *
   * ALL OF THEM, not the one project being reported on. A `ConflictingPr` carries no repo — Rust's
   * `ConflictFlags` is a `HashMap<u64, ConflictFlag>` keyed by PR NUMBER ALONE — so which repository
   * a flagged PR belongs to is a fact this side simply does not have. Asking every open repo is what
   * makes the answer safe: see {@link verifyPrOpen} for why the ambiguity can only ever cost a
   * refutation, never manufacture one.
   */
  scopes(): readonly VerifyScope[];
  /** Where this agent's branch lives. `undefined` → every claim about it is unreadable. */
  scopeForAgent(agentId: string): VerifyScope | undefined;
  /** This agent's goal, for `goal-unmet`. `undefined` when it has none. */
  goalFor(agentId: string): AgentGoal | undefined;
  /** `fetchOpenPrs`. `null` is "could not ask", NEVER "no open PRs" — the distinction this rests on. */
  openPrs(root: string, projectId: string): Promise<PrRow[] | null>;
  /** `agentBranchStatus`. Rejects → unreadable. */
  branchStatus(root: string, projectId: string, agentId: string): Promise<BranchStatus>;
  /** `agentWorkflowState` WITH the PR probe on — `prState` is half of what refutes a retire claim. */
  workflowState(root: string, projectId: string, agentId: string): Promise<WorkflowState>;
}

/** What one repo's re-read said. `rows === null` is a failed probe and answers nothing. */
interface PrReading {
  rows: PrRow[] | null;
  /** The list was capped, so an absent number is not evidence of absence. */
  saturated: boolean;
}

/**
 * Is this pull request still open?
 *
 * ── WHY "ABSENT FROM THE LIST" IS THE TEST ───────────────────────────────────────────────────────
 * `project_open_prs` lists what is OPEN. A number that was there and is not is merged or closed, and
 * for this claim those are the same answer: the report's sentences ("cannot merge", "drifting
 * further with every merge") are about a PR that is still waiting, and both are false once it has
 * stopped waiting.
 *
 * ── THE THREE WAYS THIS REFUSES TO ANSWER, AND WHY EACH IS NECESSARY ─────────────────────────────
 *   • NOBODY ANSWERED. Every scope's probe returned `null` — no `gh`, unauthenticated, offline, no
 *     remote. Absence from a list that was never read is not absence.
 *   • SOMEBODY WAS TRUNCATED. `listSaturated` means rows were dropped at the cap, so the PR may be
 *     open and simply past row 100. This is the one that would otherwise fail silently and often.
 *   • PR NUMBERS COLLIDE ACROSS REPOSITORIES. Every repo numbers from 1, so a fleet-wide list
 *     routinely holds two different `#12` — and the flag itself carries no repo. So a match in ANY
 *     scope counts as "still open". That is deliberately the weaker answer: the worst it can do is
 *     keep reporting a merged PR because some OTHER repo has a live PR of the same number (the
 *     status quo, which the founder can act on), whereas the strict reading would drop a genuinely
 *     conflicting PR because a sibling repo had merged its same-numbered one — a silent hole in the
 *     exact class this was built to surface.
 */
export function verifyPrOpen(pr: number, readings: readonly PrReading[]): ClaimVerdict {
  const answered = readings.filter((r) => r.rows !== null);
  if (answered.length === 0) return "unreadable";
  if (answered.some((r) => r.rows!.some((row) => row.number === pr))) return "holds";
  // Nobody listed it — but a truncated list cannot support that conclusion.
  if (answered.some((r) => r.saturated)) return "unreadable";
  return "refuted";
}

/** What a fresh look at one agent's repo found. Either half may be missing on its own. */
export interface AgentReading {
  branch?: BranchStatus;
  workflow?: WorkflowState;
}

/**
 * Is this agent's work already on `origin/main`?
 *
 * `inOriginMain` is plain ancestry; `landed` is Rust's `merge_adds_nothing`, which is what catches a
 * SQUASH or rebase merge — where the tip is not an ancestor of anything but merging it in would add
 * nothing. Both are `undefined` on a Rust build predating the field, and `undefined` is not `false`.
 */
function workLanded(workflow: WorkflowState | undefined): boolean {
  return workflow?.inOriginMain === true || workflow?.landed === true;
}

/**
 * Is this agent holding work that has NOT landed — the claim `unpushed-commits` rests on?
 *
 * ── REFUTING TAKES BOTH HALVES, AND THAT IS NOT BELT-AND-BRACES ──────────────────────────────────
 * "Unlanded work" in this app is `ahead > 0 || dirty` (`unlandedWorkOf`), and the two facts come
 * from different places. `WorkflowState` knows about COMMITS and knows nothing about UNCOMMITTED
 * FILES. So refuting on ancestry alone would tell a partner to stop worrying about work that is
 * genuinely sitting unsaved in its worktree — which is the same shape of wrong answer as the merged
 * PR, one field over. A fresh `BranchStatus` is what supplies the other half.
 *
 * `unlandedWorkOf` is REUSED rather than restated: it already declines to answer for a parked tree
 * (`worktreeOnBranch === false`), where the dirt belongs to whatever branch got checked out into it.
 * A second copy of that rule here is a second thing to keep in step.
 */
export function verifyHoldsUnlandedWork(reading: AgentReading): ClaimVerdict {
  // ANCESTRY IS CHECKED FIRST, AND THE ORDER IS THE WHOLE FIX. `ahead` is measured against the ref
  // the branch was cut from, so it stays greater than zero for work that has SINCE MERGED — reading
  // it first makes `unlandedWorkOf` answer `true` and the landed branch reports as still-holding,
  // which is precisely the finding this claim exists to refute. Written the other way round, this
  // function was green on every test that did not put the two facts in conflict.
  if (cleanTree(reading.branch) && workLanded(reading.workflow)) return "refuted";
  const fresh = unlandedWorkOf(reading.branch);
  if (fresh === false) return "refuted";
  if (fresh === true) return "holds";
  return "unreadable";
}

/**
 * Is this worktree affirmatively free of UNCOMMITTED files?
 *
 * Requires `worktreeOnBranch !== false` for the same reason `unlandedWorkOf` does: a parked tree's
 * dirt belongs to whatever branch got checked out into it, so its `dirty` says nothing about this
 * agent — in either direction. A parked tree therefore answers `false` here and every caller falls
 * through to the weaker reading rather than treating "not this branch's dirt" as "no dirt".
 */
function cleanTree(status: BranchStatus | undefined): boolean {
  return status !== undefined && status.worktreeOnBranch !== false && status.dirty === false;
}

/**
 * Is this agent holding NOTHING unlanded — the load-bearing half of "safe to retire"?
 *
 * ── AN OPEN PR REFUTES IT OUTRIGHT ───────────────────────────────────────────────────────────────
 * This is the check that catches the founder's actual case. An agent WAITING TO MERGE ITS OWN PR has
 * pushed everything, so a branch poll can read `ahead: 0, dirty: false` and the retire claim goes
 * through — twice on 2026-08-07, and retiring either would have destroyed the work. `prState`
 * answers the question the branch alone cannot: the work exists, it is not on main, and something is
 * still in flight for it.
 *
 * Note the direction of the two `refuted` arms: both are affirmative findings of work. Nothing here
 * refutes on an absence, because an absence is what an unread repo produces.
 */
export function verifyHasNoUnlandedWork(reading: AgentReading): ClaimVerdict {
  if (reading.workflow?.prState === "open") return "refuted";
  // The mirror of `verifyHoldsUnlandedWork`'s ordering, and it must stay a mirror: work that has
  // MERGED still reads `ahead > 0` against the ref the branch was cut from, so without this an agent
  // whose work shipped could never be recommended for retirement — the class would go quietly and
  // permanently silent for exactly the agents it is meant to clean up after.
  if (cleanTree(reading.branch) && workLanded(reading.workflow)) return "holds";
  const fresh = unlandedWorkOf(reading.branch);
  if (fresh === true) return "refuted";
  if (fresh === false) return "holds";
  return "unreadable";
}

/**
 * Is this agent's goal still UNMET — what an escalation and an expiry both presuppose?
 *
 * ── RE-EVALUATED AGAINST THE GOAL'S OWN `verify` KIND, WHICH ANSWERS EXACTLY ONE OF THREE ────────
 * `goalVerify`'s header states the position and this is a consumer of it, not a second opinion:
 *
 *   • `landed` — A MACHINE ANSWERS. Git says whether the work is on origin/main, the agent
 *     contributes nothing to that value, and this is the same proof `canSelfMarkMet` accepts.
 *   • `command` — nothing in the app runs a goal's `cmd` yet. Until an executor exists this is
 *     honestly unreadable; the day one lands, this is one of the places that changes.
 *   • `human` — by construction no machine can answer it. That is the kind's whole purpose, and
 *     guessing here would be an escape hatch wearing an honest label.
 *
 * A goal that STATED no check falls back to `inferGoalVerify`, which reads its own words and returns
 * `landed` only for a goal phrased as a landing question. That is the same inference the goal
 * machinery already uses, so a goal it would close from git is one this will also stop reporting as
 * blocked — rather than the two surfaces disagreeing about the same sentence.
 *
 * ── THE HONEST LIMIT, STATED BECAUSE IT IS INVISIBLE ─────────────────────────────────────────────
 * An escalated `human`-verified goal whose work is, in fact, finished still reports as escalated.
 * That is not this file failing to try — it is the app having no machine answer for that goal, which
 * is precisely what the human kind means. The founder's 'Unblock The Conflicting Three' is that
 * case. Widening it means giving those goals a checkable criterion, not weakening the rule here.
 */
export function verifyGoalUnmet(goal: AgentGoal | undefined, reading: AgentReading): ClaimVerdict {
  if (goal === undefined) return "unreadable";
  // ALREADY LATCHED. Whoever marked it — the agent under `canSelfMarkMet`, or a person — the goal is
  // met, and a report calling it a dead end is describing something that finished.
  if (goal.metAt !== undefined) return "refuted";

  const verify = goal.verify ?? inferGoalVerify(goal.text);
  if (verify?.kind !== "landed") return "unreadable";

  if (workLanded(reading.workflow)) return "refuted";
  // Affirmatively NOT landed: we read the branch and its work is not contained anywhere. Reported as
  // `holds` rather than `unreadable` so the log can tell "we checked, it really is stuck" from "we
  // could not check" — the same distinction every other three-valued reading in the Pusher keeps.
  if (reading.workflow !== undefined) return "holds";
  return "unreadable";
}

/** `undefined` for anything that rejected — a failed probe answers nothing, it does not answer no. */
async function tryRead<T>(what: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (e) {
    log.debug("pusher", `verify probe failed: ${what}`, { error: String(e) });
    return undefined;
  }
}

/**
 * The verifier the Pusher's sweep calls — one round of re-reads, one verdict per claim.
 *
 * NEVER THROWS AND NEVER PARTIALLY ANSWERS A CLAIM. Anything it could not read is simply absent from
 * the map, which `verdictOf` reads as `unreadable`. `sweepPushers` guards this too; both are
 * deliberate, because a throw here would abandon the rest of the roster mid-sweep and an offline
 * machine would stop reporting quota walls rather than merely stop verifying them.
 */
export function makePusherVerifier(
  deps: PusherVerifierDeps,
): (claims: readonly PusherClaim[]) => Promise<ClaimVerdicts> {
  return async (claims) => {
    const verdicts = new Map<string, ClaimVerdict>();
    if (claims.length === 0) return verdicts;

    // ── BATCH PER SUBJECT ───────────────────────────────────────────────────────────────────────
    const wantsPrs = claims.some((c) => c.kind === "pr-open");
    const agentIds = [...new Set(claims.flatMap((c) => (c.kind === "pr-open" ? [] : [c.agentId])))];

    const prReadings: PrReading[] = [];
    if (wantsPrs) {
      const scopes = deps.scopes().filter((s) => s.rootPath);
      const answers = await Promise.all(
        scopes.map((s) => tryRead("openPrs", () => deps.openPrs(s.rootPath!, s.projectId))),
      );
      for (const rows of answers) {
        // `undefined` (the probe threw) and `null` (it answered "could not determine") are the same
        // fact here and are kept as one: nothing was read.
        prReadings.push({
          rows: rows ?? null,
          saturated: (rows ?? []).some((r) => r.listSaturated === true),
        });
      }
    }

    const agentReadings = new Map<string, AgentReading>();
    await Promise.all(
      agentIds.map(async (agentId) => {
        const scope = deps.scopeForAgent(agentId);
        if (!scope?.rootPath) {
          // No repo to look in. Left out of the map entirely, so every claim about this agent reads
          // as unreadable rather than as a clean tree.
          return;
        }
        const [branch, workflow] = await Promise.all([
          tryRead("branchStatus", () => deps.branchStatus(scope.rootPath!, scope.projectId, agentId)),
          tryRead("workflowState", () => deps.workflowState(scope.rootPath!, scope.projectId, agentId)),
        ]);
        agentReadings.set(agentId, {
          ...(branch !== undefined ? { branch } : {}),
          ...(workflow !== undefined ? { workflow } : {}),
        });
      }),
    );

    // ── ANSWER ──────────────────────────────────────────────────────────────────────────────────
    for (const claim of claims) {
      if (claim.kind === "pr-open") {
        verdicts.set(claimKey(claim), verifyPrOpen(claim.pr, prReadings));
        continue;
      }
      const reading = agentReadings.get(claim.agentId) ?? {};
      const verdict =
        claim.kind === "agent-holds-unlanded-work"
          ? verifyHoldsUnlandedWork(reading)
          : claim.kind === "agent-has-no-unlanded-work"
            ? verifyHasNoUnlandedWork(reading)
            : verifyGoalUnmet(deps.goalFor(claim.agentId), reading);
      verdicts.set(claimKey(claim), verdict);
    }

    const refuted = [...verdicts.values()].filter((v) => v === "refuted").length;
    if (refuted > 0) {
      log.info("pusher", "verify-before-speak dropped findings contradicted at emit time", {
        claims: claims.length,
        refuted,
      });
    }
    return verdicts;
  };
}
