// agentGoalReading — the ONE place a control surface turns an agent record into "what is its goal,
// is it stalled, is it thrashing".
//
// WHY IT IS A SERVICE AND NOT THREE CALLS AT EACH CALL SITE. Two surfaces answer this question —
// `conciergeTools/terminal.getAgentStatus` (one agent, in depth) and `controlListener.handleGetState`
// (the whole roster, compactly) — and both need the SAME evidence: the goal off the agent record,
// `engine/agentStall` over that goal plus the agent's git state, and `engine/agentThrash` over the
// hook stream. Two copies of that assembly is exactly how the two surfaces end up disagreeing about
// whether an agent is stalled, which is the failure `services/agentLiveness` was extracted to stop
// one field over (a rule stated in one handler cannot be inherited by another).
//
// EVIDENCE, NOT INFERENCE — inherited from the engine and preserved here. `engine/agentStall`
// treats an ABSENT input as "not looked up" and refuses to manufacture a stall from it, so this
// module's job is to pass `undefined` through honestly rather than to substitute a cheerful default.
// Every reader below therefore has three answers (`true` / `false` / `undefined`), and the third one
// is a real answer.
import {
  escalationQuotesStaleText,
  goalRemainingMs,
  goalStateOf,
  escalationFieldsApply,
  hasUnmetGoal,
  type AgentGoal,
  type AwaitingCloseEvidence,
  type GoalState,
} from "../engine/agentGoal";
import { describeGoalVerify } from "@sparkle/core";
import { stallReport, type StallReport } from "../engine/agentStall";
import type { ExpiryProof } from "../engine/goalExpiry";
import { quotaBlockForAgent } from "../engine/engineRegistry";
import { humanBlockFor } from "./humanBlockFor";
import { thrashReportFor, type ThrashReport } from "../engine/agentThrash";
import {
  committedWorkSeen,
  gitDerivedStage,
  unlandedWorkEvidence,
  type WorkflowStageId,
} from "../engine/workflowStage";
import { invoke } from "@tauri-apps/api/core";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useProjectStore } from "../stores/projectStore";
import { useInteractionStore } from "../stores/interactionStore";
import { calmNewAgent } from "../engine/newAgentAttention";
import { findRosterAgent } from "./knownAgents";
import type { BranchStatus, WorkflowState } from "./branchStatus";
import type { AgentTabStatus } from "../types";

/** A goal, flattened for a tool result: the raw record's timestamps are replaced by the DERIVED
 *  facts a caller actually branches on (its state now, and how long it has left), because a model
 *  reading `setAt: 1753822...` has to do date arithmetic to learn anything. The retry counters ride
 *  along because "auto-continued 19 times" is the sentence that explains an imminent escalation. */
export interface GoalReading {
  text: string;
  /** `goalStateOf` at the clock passed in — "unmet" | "met" | "discharged" | "expired" |
   *  "escalated" | "awaiting_close". Never "none": this whole object is ABSENT when there is no goal
   *  (see {@link goalReading}).
   *
   *  ⚠️ `awaiting_close` IS ONLY REACHABLE WHEN THE CALLER SUPPLIES EVIDENCE, and a caller that does
   *  must supply it to the STALL reading too. `controlListener.goalAndStallFields` publishes this
   *  object beside `stallCauses` and `resume.blockedBy` in ONE payload the concierge branches on, so
   *  a `state: "escalated"` next to `stallCauses: ["awaiting-close"]` is a self-contradiction no
   *  reader can resolve (roborev 65987). */
  state: Exclude<GoalState, "none">;
  /** Milliseconds until the TTL runs out; 0 once it has. */
  remainingMs: number;
  /** Consecutive auto-continues since progress was last seen. */
  continues: number;
  /** Auto-continues spent on this goal ever — the bound that survives a flapping progress mark. */
  totalContinues: number;
  /** Present ONLY when the goal actually escalated — `state === "escalated"`, OR `awaiting_close`
   *  layered over a set `escalatedAt` latch: why auto-continue gave up, for the human who now owns
   *  it. Keyed on the LATCH rather than on the derived state, so a live goal can never carry it. */
  escalationReason?: string;
  /**
   * `true` when {@link escalationReason} QUOTES A GOAL THIS AGENT NO LONGER HOLDS. Absent otherwise
   * — the ordinary case pays nothing, and a reader can branch on presence.
   *
   * WHY IT HAS TO RIDE ALONGSIDE THE SENTENCE. `escalationReason` is frozen at the instant
   * auto-continue gave up, and `chargeGoalDebt` deliberately carries it onto whatever the goal
   * becomes next — an agent must not be able to launder an escalation away by rewording its
   * objective. That is the right rule, and it has a consequence nobody reading the payload can see:
   * the live `text` and the frozen sentence sit side by side with nothing to tell them apart, so a
   * reader repeats a two-goals-old blocker as a live claim. The founder hit exactly this — a goal he
   * had replaced was still being quoted back at him as the thing blocking the agent.
   *
   * ⚠️ IT IS STATED HERE RATHER THAN AT THE CALL SITE, and that is the point of moving it.
   * `controlListener.handleGetState` computed this for the ROSTER and nothing computed it for
   * `get_agent_status` — which is the CONCIERGE's per-agent read, i.e. the one surface whose output
   * a human actually hears. One rule in two places is how the two came to disagree; every consumer
   * of a {@link GoalReading} now gets the same answer.
   *
   * ABSENT IS "CANNOT TELL", NOT "FRESH" — see `AgentGoal.escalatedGoalText`, which every escalation
   * persisted before that field carries no quote for. The comparison fails closed to not-stale.
   */
  escalationStale?: true;
  /** HOW this goal gets checked, rendered as one readable clause ("`pnpm test` exits 0", "a person
   *  decides"), and ABSENT when no check was stated.
   *
   *  Absence is the meaningful half: a goal with no check is one its own claimant may close, so a
   *  reader that cannot see this field cannot tell a goal someone else must sign off from one the
   *  agent will latch itself. It also makes an INHERITED check visible — a new goal that carries a
   *  check forward from a previous one reads as "a person decides" here, which is the only way the
   *  caller learns it did not get the self-markable goal it thought it set (roborev 55933). */
  verify?: string;
}

/**
 * Flatten an agent's goal for reporting, or `undefined` when it has none.
 *
 * ABSENT, NOT NULL-SHAPED. An agent with no goal gets no `goal` key at all rather than a record of
 * empty strings and zeroes — a caller can then branch on presence, and a roster of forty goal-less
 * agents costs nothing to say so. (This is also why `state` excludes "none": if you are holding one
 * of these, there IS a goal.)
 */
export function goalReading(
  goal: AgentGoal | undefined,
  now: number,
  // OPTIONAL, and absence means the record-only state — the same direction the engine takes. A
  // caller with no evidence in hand publishes exactly what it published before; a caller that has it
  // must pass it, or its own `stall` field will disagree with this one. See {@link GoalReading.state}.
  awaiting?: AwaitingCloseEvidence,
): GoalReading | undefined {
  if (goal === undefined) return undefined;
  const state = goalStateOf(goal, now, awaiting);
  // Unreachable for a defined goal — `goalStateOf` returns "none" only for `undefined` — but the
  // implication lives in another module, so it is restated rather than cast away.
  if (state === "none") return undefined;
  return {
    text: goal.text,
    state,
    remainingMs: goalRemainingMs(goal, now),
    continues: goal.continues,
    totalContinues: goal.totalContinues,
    // Only when it actually escalated: an escalation reason on a live goal would read as though the
    // fleet had already given up on it.
    //
    // ⚠️ `awaiting_close` COUNTS TOO WHEN THE LATCH IS SET (roborev 66010) — the state is DERIVED
    // and layers over `escalated`, so without that term a row which escalated and then landed
    // silently loses the sentence explaining why the fleet gave up. The history is not made false by
    // the work landing afterwards; it is exactly the context a person closing the goal wants.
    //
    // THE RULE IS `engine/agentGoal.escalationFieldsApply`, NOT AN INLINE TEST (roborev 66027). It
    // is neither the bare latch nor the bare state — both are wrong in different directions — and
    // `controlListener`'s roster keys `rearmsRemaining` on the same predicate. Two inline copies of
    // it had already drifted once, which published a met goal's re-arm allowance with no reason
    // beside it and let the concierge spend a re-arm on finished work.
    ...(escalationFieldsApply(goal, state) && goal.escalationReason !== undefined
      ? {
          escalationReason: goal.escalationReason,
          // Only ever WITH the sentence it qualifies. A stale flag on a reading that carries no
          // reason would be a warning about a string the caller cannot see.
          ...(escalationQuotesStaleText(goal) ? { escalationStale: true as const } : {}),
        }
      : {}),
    // Only when a check was actually stated — `describeGoalVerify(undefined)` returns the honest
    // "no check stated", but rendering that on every goal would put a string on the overwhelming
    // majority of readings to say nothing, and absence already says it.
    ...(goal.verify !== undefined ? { verify: describeGoalVerify(goal.verify) } : {}),
  };
}

/** The three git-shaped inputs `engine/agentStall` asks for. Every field is optional and
 *  `undefined` means NOT LOOKED UP — never "no". */
export interface StallEvidence {
  hasOpenPr?: boolean;
  hasUnlandedWork?: boolean;
  hasUncommittedChanges?: boolean;
}

/**
 * What this window can actually see about an agent's git state, read from `runtimeStore`.
 *
 * Every read here is window-local and already-polled — no `git` call, no network. That is a
 * requirement rather than an optimisation: `handleGetState` runs this for EVERY agent on the roster
 * on a call an orchestrator makes routinely, so an answer that costs a subprocess per agent would
 * cost more than the stalls it finds.
 *
 * The three `undefined` arms are the load-bearing part:
 *
 *  • NO ENTRY at all → `undefined`. This window has not polled that agent (its pane is mounted in
 *    another window, or nothing has polled yet). `stallReport` turns "no cause found, but I did not
 *    look" into the `unknown` verdict, which is the honest answer.
 *  • `prState: null` → `undefined`, NOT `false`. Rust reports `null` both for "probed, found no PR"
 *    and for a poll that did not probe GitHub at all (`probePrState` is gated), and those are
 *    indistinguishable at this boundary — the same ambiguity `WorkflowState.hasRemote` documents for
 *    its own `false`. Only "open" is evidence in either direction here.
 *  • DIRTY BUT PARKED → `undefined`. `BranchStatus.dirty` is the one field that is not derived from
 *    the branch ref, so when `worktreeOnBranch === false` the uncommitted files belong to whatever
 *    branch the tree was moved onto (the `land.sh` parking bug, bead `sparkle-rhgm`). Attributing
 *    them to THIS agent would claim a stall on another branch's work. A CLEAN tree is unambiguous
 *    either way, so `dirty: false` still answers `false`.
 */
export function stallEvidenceFor(agentId: string): StallEvidence {
  const rt = useRuntimeStore.getState();
  const openPr = readOpenPr(rt.workflowState?.[agentId]);
  const unlanded = readUnlanded(
    rt.branchStatus?.[agentId],
    rt.workflowState?.[agentId],
    rt.workflowStage?.[agentId],
  );
  const uncommitted = readUncommitted(rt.branchStatus?.[agentId]);
  // Spread-when-known rather than assign-possibly-undefined: `exactOptionalPropertyTypes` aside, a
  // key present with the value `undefined` reads as a supplied answer to anything that inspects the
  // object, and the whole point of this shape is that a missing key means "not looked up".
  return {
    ...(openPr === undefined ? {} : { hasOpenPr: openPr }),
    ...(unlanded === undefined ? {} : { hasUnlandedWork: unlanded }),
    ...(uncommitted === undefined ? {} : { hasUncommittedChanges: uncommitted }),
  };
}

/**
 * GIT'S ANSWER to "is this agent's work on origin/main?" — the evidence a `{kind:"landed"}` goal is
 * closed on. `true` / `false` / `undefined` ("not looked up").
 *
 * WHY THIS EXISTS (sparkle-vfkqz). `canSelfMarkMet` refused every `landed` goal to its own claimant
 * because nothing computed `landed`. Something did, all along — just not on this seam: the sidebar's
 * stage ladder and the unlanded-work surface have answered it since the workflow-stage work. Two
 * finished agents escalated to the founder over merged PRs while the fact sat one store read away.
 *
 * TWO CONDITIONS, AND BOTH ARE NEEDED:
 *
 *  • `workflowShipped` — the latched watermark set the first time the agent's stage reached `merged`
 *    (ORIGIN main, deliberately not `merged_local`; see runtimeStore). This is the POSITIVE half,
 *    and it must be positive: `hasUnlandedWork === false` would ALSO be true for an agent that never
 *    committed anything, which would let a goal reading "the fix is merged to origin/main" be closed
 *    by an agent that wrote no code. The watermark is written by `deriveLiveStage`, so it already
 *    carries that module's `committedSeen` guard — a no-op branch sitting on main's HEAD cannot
 *    claim it.
 *  • `unlandedWorkEvidence !== true` — the NEW-WORK CYCLE veto. The watermark is monotonic, so an
 *    agent that landed PR #1 and kept committing still reads `shipped: true` while holding unlanded
 *    commits. Closing a goal there would call an agent done over work it is visibly still holding,
 *    which is the original false-"done" this whole mechanism exists to prevent.
 *
 * NOT a new git call: every input is already-polled window-local state, same as
 * {@link stallEvidenceFor}. So an unopened pane answers `undefined`, and `undefined` fails CLOSED at
 * `canSelfMarkMet` — the agent is refused with copy telling it the reading is missing rather than
 * negative, instead of being told a human must close it.
 */
export function landedEvidenceFor(agentId: string): boolean | undefined {
  const rt = useRuntimeStore.getState();
  const bs = rt.branchStatus?.[agentId];
  const ws = rt.workflowState?.[agentId];
  const stage = rt.workflowStage?.[agentId];
  const shipped = rt.workflowShipped?.[agentId];
  // ⚠️ A LIVE READING IS REQUIRED, NOT JUST THE WATERMARKS (roborev 57794). `workflowStage` and
  // `workflowShipped` are PERSISTED across relaunch (runtimeStore `partialize`); `branchStatus` and
  // `workflowState` deliberately boot clean. So after a relaunch — or in any window that has never
  // polled this agent's pane — the two latches are present and both live signals are absent, and the
  // new-work veto below CANNOT FIRE because it reads `bs.ahead`, the very field that is missing.
  // That combination answered `true` from months-old localStorage: land PR #1, get a new task, write
  // three unlanded commits, relaunch, and the agent could close its goal on a merge that predates
  // the work — the false "done" this gate exists to prevent, restored by the fix for it.
  //
  // Treating it as "not looked up" is the honest reading and costs only a retry after the next poll,
  // which is the same remedy the refusal copy already gives.
  //
  // IT MUST BE `bs` SPECIFICALLY, NOT "either live map" (roborev 57796). The first version accepted
  // `ws !== undefined` as sufficient, which narrowed the hole without closing it: the veto below
  // fires on `bs.ahead`, and `unlandedWorkEvidence` bails early only when BOTH `bs` and
  // `stageOverride` are absent — so a `workflowState`-only reading plus a persisted `merged` stage
  // still fell through to `hasUnmergedCommittedWork(…) === false` and answered `true`, with the veto
  // structurally unable to fire. The two maps are populated independently (`AgentStatusResult.branch`
  // is nullable), so that is a reachable state, not a hypothetical. Require the field the veto
  // actually consumes; `ws` remains an INPUT to the evidence, never an alternative to `bs`.
  if (bs === undefined) return undefined;
  // A LIVE, ORIGIN-SCOPED LANDING READING OUTRANKS THE MONOTONIC `shipped` WATERMARK (sparkle-lh0fdg,
  // sparkle-qh6j7g). `workflowShipped` only latches the first time a poll HAPPENS TO OBSERVE the stage
  // reach `merged` on ORIGIN — a latch that moves only when something is watching. So a branch that
  // merged seconds ago, or any pane that has not polled since the merge (including right after a
  // relaunch, when the two watermarks persist but `workflowState` boots clean and then repopulates a
  // tick later), reads `shipped:false` while git ALREADY reports the tip on origin/main. Returning
  // `false` there told a finished agent to "go land it," reopening the 20-resume escalation loop this
  // gate exists to stop — over work that was already merged. The rule (founder, sparkle-lh0fdg): a
  // verifier whose inputs the agent cannot influence must prefer a LIVE measurement over a latch.
  //
  // The live substitute is `ws.landedOnOrigin` (the squash/rebase/ancestry-against-origin proof) or
  // `ws.inOriginMain` (tip is an ancestor of origin/main) — both are exactly "work is on origin/main".
  // Both are trivially true for a no-op branch sitting on main's HEAD, so gate them behind
  // `committedWorkSeen`, the SAME no-op guard `deriveLiveStage` applies before it latches the
  // watermark (one implementation, shared). `pushed`/`prState` in that guard are never true for a
  // no-op branch, so a genuinely-landed branch clears it while a bare cut from main does not. The
  // new-work-cycle veto (`unlandedWorkEvidence`, below) still runs, so a branch that landed PR #1 and
  // kept committing is still refused.
  //
  // THE LANDING STAMP IS PART OF THAT GUARD, because for a MERGED-THEN-DELETED branch it is the only
  // signal left (sparkle-qh6j7g and sparkle-lh0fdg, third instalment). Deleting the remote head on
  // merge — GitHub's default — drives every other input back to a bare cut's values: `ahead` 0,
  // `pushed` false (no remote ref to be ahead of), and `prState` null, because `worktree.rs`
  // deliberately suppresses the commit probe for a branch carrying no work of its own so a no-op
  // branch cannot inherit main's merge commit. The row then reads as "never authored anything" and
  // the agent is refused with "git says it is not on origin/main yet" — permanently, over merged
  // work, which is the escalation loop both earlier beads were filed to end.
  //
  // It is SAFE here for the same reason `deriveLiveStage` already trusts it (`workflowStage.ts`:
  // `crossRepoStamp: input.crossRepo?.stamp != null`): nothing writes a stamp except an agent
  // explicitly naming the repository and pull request its work landed in, so it is never true for a
  // no-op branch. Passing it is also what `committedWorkSeen`'s own contract REQUIRES of its two
  // consumers — "a stage reading `merged` while the goal gate reads `no work` is the cross-surface
  // disagreement this module exists to forbid". This gate was the half not passing it.
  //
  // It establishes only that WORK EXISTS. Both origin proofs above still gate the positive answer,
  // and the new-work veto below still has the last word, so a stamp can neither self-certify a
  // landing the bound repo can see is absent nor close a goal over fresh unlanded commits.
  const liveLandedOnOrigin =
    (ws?.landedOnOrigin === true || ws?.inOriginMain === true) &&
    committedWorkSeen({
      gitStage: gitDerivedStage(bs),
      prev: stage,
      aheadOfBase: ws?.aheadOfBase,
      pushed: ws?.pushed,
      prState: ws?.prState,
      crossRepoStamp: findRosterAgent(agentId)?.landedElsewhere != null,
    });
  if (shipped !== true && !liveLandedOnOrigin) return false;
  return unlandedWorkEvidence({ bs, ws, stageOverride: stage }) === true ? false : true;
}

/** The Rust probe's reply (`goal_landed_probe.rs::LandedProbe`).
 *
 *  ⚠️ `landed` IS `boolean | null`, NOT `boolean | undefined`. It is a Rust `Option<bool>`, and
 *  serde emits the key with a **null** value for `None` — it omits the key only under
 *  `skip_serializing_if`. TypeScript's `field?: T` means `T | undefined`, which EXCLUDES null, so
 *  the optimistic spelling would describe a shape the wire cannot produce (bead sparkle-16y6h).
 *  Both `null` and absent are treated as "could not tell" below, which is the same answer. */
interface LandedProbeReply {
  landed?: boolean | null;
  reason?: string | null;
}

/** Hard ceiling on the whole probe, JS side. Rust already bounds each subprocess (5s local, 10s for
 *  the one fetch), so this is the backstop for the IPC itself hanging — the seam it guards is an
 *  agent waiting on a reply, and an unbounded wait there is indistinguishable from the refusal loop
 *  this whole change exists to end. Comfortably above the Rust budget so a slow-but-working fetch
 *  still gets to answer. */
const LANDED_PROBE_TIMEOUT_MS = 30_000;

/**
 * THE ON-DEMAND SECOND READER — git asked LIVE, for ONE agent, at the `set_agent_goal_met` seam.
 *
 * ── WHY {@link landedEvidenceFor} CANNOT BE THE ONLY ANSWER ──────────────────────────────────────
 * That reader is window-local by contract: it reads already-polled store state and shells nothing,
 * because `handleGetState` calls it for EVERY agent on a call orchestrators make routinely. Nothing
 * here weakens that — the roster hot path still never reaches this function.
 *
 * But its first hard bail is `if (bs === undefined) return undefined`, and `runtimeStore.branchStatus`
 * has exactly ONE writer: a MOUNTED AgentPane. Panes mount lazily per project, so for an agent whose
 * pane is not mounted in this window — or right after a relaunch, or in a second window — that bail
 * fires forever. `canSelfMarkMet` fails closed on `landed !== true`, and the refusal's own remedy
 * ("mark it met again once a branch poll lands") never arrives, because nothing is polling that
 * agent. Measured outcome: an agent whose work is PROVABLY merged is refused, auto-resumed, and
 * eventually escalates a false alarm to a human — beads sparkle-h3wqm, sparkle-ayj8oe,
 * sparkle-k2ocyl, sparkle-e0f34k, sparkle-4s07tm, sparkle-3d4ouj, sparkle-ch57hz, sparkle-28ifhw,
 * sparkle-aqd0xp, sparkle-v22kuv, sparkle-fiyfrn.
 *
 * ── WHAT MAKES THE COST ACCEPTABLE HERE AND NOWHERE ELSE ─────────────────────────────────────────
 * One call, one agent, made by an agent that believes it has finished, at most once per attempt.
 * That is affordable; N agents × every roster tick is not. Do NOT call this from `awaitingCloseEvidenceFor`,
 * `expiryProofFor`, or `handleGetState` — each of those is per-agent-per-tick and their own doc
 * comments say why.
 *
 * ── `undefined` IS THE ONLY FAILURE VALUE ────────────────────────────────────────────────────────
 * Every error path — no worktree recorded, no project row, a rejected invoke, a null `landed`, the
 * timeout above — answers `undefined`, never `false`. `false` makes `selfMarkRefusal` emit "git says
 * it is not on origin/main yet", which is exactly the sentence these beads report as a lie; only a
 * real git ancestry verdict may produce it.
 */
export async function probeLandedFromGit(agentId: string): Promise<boolean | undefined> {
  // Resolve BOTH halves from the roster row: the agent's own worktree (where HEAD is read) and the
  // project's main checkout (where the default branch NAME is resolved). The Rust side declines
  // outright without a root — see `landed_probe_in` for why guessing it can silently turn "have I
  // landed?" into "have I pushed?".
  let worktree: string | null = null;
  let root: string | null = null;
  for (const p of useProjectStore.getState().projects) {
    const a = p.agents.find((x) => x.id === agentId);
    if (a) {
      worktree = a.worktreePath;
      root = p.rootPath;
      break;
    }
  }
  if (!worktree || !root) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      invoke<LandedProbeReply>("agent_landed_probe", { worktree, root }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LANDED_PROBE_TIMEOUT_MS);
      }),
    ]);
    const landed = reply?.landed;
    return typeof landed === "boolean" ? landed : undefined;
  } catch {
    // An unregistered command, a dead worktree, a panicking probe — all "we could not tell". The
    // caller's copy for that is "your branch's git state has not been read yet", which is true.
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Did this agent's work reach the default branch AT OR AFTER the goal was set?
 *
 * {@link landedEvidenceFor} answers "is this agent's branch landed", which is a fact about the
 * AGENT, not about the goal it currently holds. `workflowShipped` is a monotonic latch cleared only
 * on close or reset, so it survives into the NEXT goal — and without this comparison an agent that
 * landed PR #1 and was then handed a fresh objective would read as finished the moment it went
 * quiet, over work that predates the thing it is supposed to be doing.
 *
 * ⚠️ FALSE WHEN THE TIMESTAMP IS MISSING, which is the fail-closed direction and covers a real
 * population: watermarks latched before `workflowShippedAt` existed persist without one. "I cannot
 * tell when this merged" must not present as "it merged for this goal".
 *
 * ONE IMPLEMENTATION, deliberately. `controlListener` had a private copy of exactly this rule for
 * the roster's own `shipped_after_goal_set` field; it now delegates here. Two answers to "has this
 * shipped for this goal" would drift, and one of them now decides whether an agent is resumed.
 */
export function shippedAfterGoalSet(agentId: string, goal: AgentGoal | undefined): boolean {
  if (goal === undefined) return false;
  const at = useRuntimeStore.getState().workflowShippedAt?.[agentId];
  return at !== undefined && at >= goal.setAt;
}

/**
 * The evidence `engine/agentGoal.goalStateOf` needs to reach `awaiting_close`, or `undefined` when
 * there is no goal to reach it for.
 *
 * ⚠️ NO GIT CALL. Both readers below are already-polled window-local store state, the same property
 * {@link stallEvidenceFor} and {@link landedEvidenceFor} have — this is called once per agent per
 * roster tick and per continuation sweep, so it has to stay a map lookup.
 *
 * A window that has never polled this agent's pane answers `landed: undefined`, and the engine
 * treats that as "not looked up" and leaves the goal in its ordinary state. That is the safe
 * direction HERE (unlike most gates in this app): `awaiting_close` STOPS auto-continue, so a
 * mistaken positive strands an agent that still had work, while a mistaken negative costs only the
 * status quo — the row keeps being resumed exactly as it does today.
 */
export function awaitingCloseEvidenceFor(
  agentId: string,
  goal: AgentGoal | undefined,
): AwaitingCloseEvidence | undefined {
  if (goal === undefined) return undefined;
  return {
    landed: landedEvidenceFor(agentId),
    shippedAfterGoalSet: shippedAfterGoalSet(agentId, goal),
  };
}

/**
 * The evidence `engine/goalExpiry.decideExpiry` adjudicates an expired goal on — or `undefined`,
 * meaning WE DID NOT LOOK.
 *
 * ALL-OR-NOTHING, and that is the safety property rather than a convenience. Every boolean below is
 * a verdict, and `decideExpiry` can latch a goal permanently closed on them, so a partially-known
 * proof must not exist: absent evidence has to be indistinguishable from "not looked up" at the
 * boundary, or a missing reading gets read as a negative finding. This is the same
 * `undefined`-is-not-`false` discipline {@link stallEvidenceFor} is built on, held one notch
 * stricter because the consumer WRITES rather than merely renders.
 *
 * NOT A NEW GIT CALL. Every input is already-polled, window-local store state, exactly as
 * {@link stallEvidenceFor} and {@link landedEvidenceFor} are — this runs on the 15s continuation
 * sweep for every agent on the roster, so an answer costing a subprocess per agent would cost more
 * than the stalls it resolves.
 *
 * THE TWO SHAS AND `hasOpenPr` ARE ALLOWED TO BE ABSENT, and the exemption is earned by a test each
 * one passes: `decideExpiry` reads them from exactly ONE arm apiece, so their absence withholds that
 * single decision (`proof-unauditable`, `pr-state-unknown`) instead of colouring any other. Nothing
 * is inferred from it anywhere else.
 *
 * ⚠️ `hasOpenPr` WAS REQUIRED HERE, AND THAT SHIPPED THE WHOLE MECHANISM INERT for the population it
 * exists to rescue. `readOpenPr` answers `undefined` unless `workflowState` is present AND
 * `prState !== null` — and `null` is the ordinary reading for a branch that simply has no PR, since
 * the probe cannot tell "no PR" from "did not ask". So the target case (an agent walled by an
 * outage, work committed, no PR yet) produced NO proof at all, `decideExpiry` refused with
 * `evidence-unreadable`, and the goal was never re-armed — the dead letter this module was written
 * to end, reconstructed one layer down. Same reasoning as the shas, same fix: withhold the one
 * decision, not the evidence.
 */
export function expiryProofFor(agentId: string): ExpiryProof | undefined {
  const rt = useRuntimeStore.getState();
  const bs = rt.branchStatus?.[agentId];
  // The live reading is required, for the reason spelled out at `landedEvidenceFor`: `workflowStage`
  // and `workflowShipped` are PERSISTED across relaunch while `branchStatus` deliberately boots
  // clean, so without this an answer could be served from months-old localStorage — the false "done"
  // roborev 57794 restored once already.
  if (bs === undefined) return undefined;

  // ⚠️ PARKED IS ANSWERED HERE, BEFORE THE GATE, or the refusal it exists to name never happens.
  // `readUncommitted` returns `undefined` for precisely `dirty && worktreeOnBranch === false` — and a
  // parked worktree is parked BECAUSE someone checked a topic branch into it and is working there,
  // so dirty-and-parked is the majority of that population (21 of ~48 worktrees, measured). Those
  // therefore tripped the all-or-nothing gate and degraded into `evidence-unreadable`, which is the
  // exact outcome the pass-through below was written to prevent: only a parked-and-pristine tree
  // ever reached `worktree-parked`, and the two refusals say different things to a human.
  //
  // THE OTHER FIELDS ARE FAIL-CLOSED VALUES, not readings. `decideExpiry` returns at
  // `!proof.worktreeOnBranch` without consulting them, and these are chosen so that even a future
  // arm which did consult them could not write a latch: `landed:false` and `clean:false` refuse a
  // discharge, `unlanded:false` refuses an abandonment, and an absent `hasOpenPr` refuses one again.
  // A parked tree's evidence belongs to another branch; nothing here is attributable to this agent.
  if (bs.worktreeOnBranch === false) {
    return { landed: false, clean: false, unlanded: false, worktreeOnBranch: false };
  }

  const landed = landedEvidenceFor(agentId);
  const ev = stallEvidenceFor(agentId);
  const { hasOpenPr, hasUnlandedWork, hasUncommittedChanges } = ev;
  if (landed === undefined || hasUnlandedWork === undefined || hasUncommittedChanges === undefined) {
    return undefined;
  }

  return {
    landed,
    clean: hasUncommittedChanges === false,
    unlanded: hasUnlandedWork,
    // SPREAD-WHEN-KNOWN, the shape `stallEvidenceFor` already uses: a key present with the value
    // `undefined` reads as a supplied answer to anything inspecting the object, and the whole point
    // of this field being optional is that a missing key means "not looked up".
    ...(hasOpenPr === undefined ? {} : { hasOpenPr }),
    // Always `true` by the time we reach here — the `false` case returned above. Kept as a field
    // rather than dropped because `decideExpiry` owns the parked rule and names it in its refusal
    // (`worktree-parked`), which is a sentence a human can act on; this reader only supplies the
    // fact. `undefined` (a Rust build predating the field) reads as "on branch", the same
    // back-compat direction `BranchStatus` documents for it.
    worktreeOnBranch: true,
  };
}

/** `prState: null` is ambiguous — see {@link stallEvidenceFor}. Only "open" is a positive reading. */
function readOpenPr(ws: WorkflowState | undefined): boolean | undefined {
  if (ws === undefined || ws.prState === null) return undefined;
  return ws.prState === "open";
}

/**
 * THE SAME RULE THE SIDEBAR USES, not a second copy (roborev 55525).
 *
 * This used to read the stage watermark ALONE, which made the two surfaces contradict each other on
 * the exact case the sidebar had just been fixed for: the new-work cycle (merge PR #1, keep committing
 * on the same branch) has a monotonic `merged` watermark outranking live `ahead: 3`, so the sidebar
 * reported `stalled` / `unlanded-work` while `get_state` and `get_agent_status` reported `finished` —
 * for the same agent, at the same moment, on the surface a concierge actually sweeps. The inputs were
 * always in hand here; only the rule was missing. See `unlandedWorkEvidence` for why it yields to
 * reachability but pointedly NOT to `prState`.
 */
function readUnlanded(
  bs: BranchStatus | undefined,
  ws: WorkflowState | undefined,
  stage: WorkflowStageId | undefined,
): boolean | undefined {
  return unlandedWorkEvidence({ bs, ws, stageOverride: stage });
}

/** A parked worktree's dirt is some other branch's — see {@link stallEvidenceFor}. A clean tree is
 *  unambiguous whoever it belongs to. */
function readUncommitted(bs: BranchStatus | undefined): boolean | undefined {
  if (bs === undefined) return undefined;
  if (!bs.dirty) return false;
  return bs.worktreeOnBranch === false ? undefined : true;
}

/**
 * Is this agent idle-and-finished, idle-and-stalled, merely unexamined, or busy? The goal comes from
 * the agent record; the git evidence from {@link stallEvidenceFor}.
 *
 * THE STATUS CORRECTION HAPPENS HERE, not in the callers, and that is the whole point of this
 * function existing (roborev 55308). Extracting the assembly into one module was supposed to make
 * the two surfaces unable to disagree about who is stalled — but they were handing it differently
 * corrected statuses: `getAgentStatus` passed the `calmNewAgent`-corrected value (which rewrites
 * `idle` → `new` for a briefless, freshly-spawned agent) while `handleGetState` passed the raw map.
 * `new` is deliberately excluded from `agentStall.isQuiet` and `idle` is not, so one briefless agent
 * with a goal got `stalled` from one surface and `active — "Status 'new' — not idle."` from the other,
 * at the same moment. Applying the correction inside means a caller CANNOT supply an uncorrected
 * status: the divergence moved from the derivation to its input, and this puts it back.
 */
export function stallReadingFor(
  agentId: string,
  status: AgentTabStatus,
  goal: AgentGoal | undefined,
  now: number,
): StallReport {
  const humanBlock = humanBlockFor(agentId);
  const awaitingClose = awaitingCloseEvidenceFor(agentId, goal);
  return stallReport({
    status: correctedStatusFor(agentId, status, now),
    now,
    goal,
    // The account-limit wall, read from the same StatusEngine that observed it. Supplied HERE rather
    // than by each caller for the reason the corrected status is: `get_agent_status` and the roster
    // both publish this report, and a wall visible to one but not the other is the same
    // one-object-contradicts-itself bug the correction above exists to prevent.
    quotaBlock: quotaBlockForAgent(agentId, now),
    // The agent's own `blocked-on-human` answer, supplied HERE for exactly the reason the quota wall
    // and the corrected status are: this report is what `get_agent_status` and the roster publish, so
    // a human block visible to the sidebar but not to them is the same one-object-contradicts-itself
    // divergence the two comments above exist to prevent (roborev 65339).
    ...(humanBlock ? { humanBlock } : {}),
    // Whether the work already shipped for THIS goal, supplied HERE for the third time on the same
    // argument the two comments above make: this report is what `get_agent_status`, the roster and
    // the sidebar all publish, and a row that reads "done — awaiting your close" on one surface and
    // "blocked on you" on another is the one-object-contradicts-itself divergence this function
    // exists to prevent — in the loudest colour the app has.
    ...(awaitingClose ? { awaitingClose } : {}),
    ...stallEvidenceFor(agentId),
  });
}

/**
 * The status a control surface should REPORT, corrected for "spawned but never briefed".
 *
 * Exported because a surface that publishes `status` and `stall` side by side has to derive both from
 * the SAME value or it contradicts itself in one object (roborev 55451). The roster used to emit the
 * RAW status next to a `stall` computed from the corrected one, and the omission rule for `stall` is
 * "the `active` verdict is already implied by `status`" — so a briefless, freshly-spawned agent with a
 * goal published `status: "idle"`, an unmet goal, and NO `stall` key. Applying the documented rule to
 * that row reads "active", which the `idle` in the same object denies. A caller sweeping for stuck
 * agents could resolve it neither way.
 *
 * `?? status` is not defensive noise: `calmNewAgent` returns `undefined` for an unobserved agent, and
 * this function's callers have a concrete status in hand and need one back.
 *
 * IDEMPOTENT BY CONTRACT, and callers rely on it (roborev 55588). `handleGetState` hands in a status
 * already corrected by `withNewAgentCalm` over the whole roster, so this runs a second time on the
 * same value — which must be a no-op, and is: `calmNewAgent` only rewrites `idle`/`blocked`, and its
 * output `new` is neither. Keeping the internal call rather than trusting every caller is deliberate;
 * it is what stops `get_agent_status` (the other caller, which has no roster-wide map) from diverging,
 * and that divergence is the bug this function was extracted for. If you ever make `calmNewAgent`
 * rewrite `new`, this stops being idempotent and the roster row starts double-correcting.
 */
export function correctedStatusFor(
  agentId: string,
  status: AgentTabStatus,
  now: number,
): AgentTabStatus {
  const tab = findRosterAgent(agentId);
  if (!tab) return status;
  return calmNewAgent(status, tab, now, useInteractionStore.getState().lastAt[agentId]) ?? status;
}

/**
 * Is this agent looping / out of context? `undefined` when this window has never seen a hook event
 * for it.
 *
 * THE `undefined` MUST REACH THE CALLER. `thrashReportFor` deliberately does not synthesise a
 * healthy-looking report for an agent nobody is watching, and a surface that turned that into
 * `thrashing: false` would publish calm on no evidence — the same false negative `liveness` and
 * `rollupDot`'s null arm exist to prevent, one module over.
 *
 * `goalOutstanding` is supplied because the `no-progress` rule is only an alarm while there is goal
 * work outstanding; without it, three prose turns in a row (a human asking an agent three questions)
 * read as "producing output without doing anything".
 */
export function thrashReadingFor(
  agentId: string,
  goal: AgentGoal | undefined,
  now: number,
): ThrashReport | undefined {
  return thrashReportFor(agentId, now, {
    goalOutstanding: hasUnmetGoal(goal, now),
    // Same wall, same reader, same clock as `stallReadingFor` — so the two reports published side by
    // side in one `get_agent_status` response cannot disagree about whether the agent is blocked.
    quotaBlock: quotaBlockForAgent(agentId, now),
  });
}
