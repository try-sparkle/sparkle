// landedRedVeto — A ROW WHOSE WORK ALREADY LANDED IS FINISHED, NOT BLOCKED.
//
// RED on an agent row means exactly one thing (the 2026-08-06 rule, recorded on `lapsed` in
// packages/ui/tokens.ts): *only you, the human, can clear this*. The founder has repeatedly been
// handed rows sitting RED whose PRs already read MERGED on GitHub. Nothing is owed on such a row —
// it is done. A colour that fires on finished rows is how real red stops meaning anything, and red
// is the only signal this app has that cannot be rebuilt once it is spent.
//
// THIS REPO HAS PAID FOR THAT TWICE ALREADY, and both receipts are in tokens.ts:
//   • `unmerged` was RED until 2026-07-26. On a real fleet 27 of 51 agents sat in the
//     committed-but-unlanded band, so the wall of red said "most of your agents have a branch",
//     not "these agents need you".
//   • `lapsed` was carved out of red on 2026-08-06 after the founder triaged a day of rows that
//     needed nothing from him — clean worktrees, every PR merged, all wearing the loudest signal
//     the app has: *"Why are all these agents red? They don't seem to need anything from me."*
// This module is the third instalment of the same argument, applied to a fact neither of those
// carve-outs reads: not "the machinery stopped" but "THE WORK LANDED".
//
// ── WHAT THIS IS, AND HOW IT DIFFERS FROM THE EXISTING `awaiting-close` VETO ─────────────────────
//
// `engine/agentStall`'s `awaiting-close` cause is the existing art, and it is the same idea. Its
// own doc comment states the reasoning, and it is quoted here rather than restated because it is
// the reasoning this module inherits:
//
//     "`blocked-on-human` is the agent's own answer to 'what are you waiting on', and for a row in
//      this state that answer is ACCURATE — a person genuinely is the next actor. What is wrong is
//      the COLOUR it earns. Red is reserved for 'the agent is stuck and only the founder can
//      unblock it'; an agent whose PR is merged and whose goal only needs a bookkeeping click is
//      not stuck, it is done."
//
//     "AND THE VETO IS NARROW, WHICH IS THE HALF THAT MATTERS. It requires `awaiting_close`, which
//      requires git-proven landed work POSTDATING the goal. A `blocked-on-human` answer from any
//      other row — no landed work, work that landed for a previous goal, an agent-closable check —
//      stays RED, untouched."
//
// HOW THIS ONE DIFFERS, in the three ways that matter:
//
//   1. IT IS KEYED ON THE STATUS, NOT ON A STALL CAUSE. `awaiting-close` demotes ONE cause
//      (`blocked-on-human`) inside `agentStall`'s cause list, which reaches the dot only through
//      `stallEscalation.escalationFor` and therefore only for the `idle`/`unmerged` rows that
//      surface is allowed to escalate (`ESCALATABLE`). A row that is ALREADY `errored`,
//      `waiting`, `approval` or `blocked` never passes through that door at all. Those four are
//      exactly the rows the founder is looking at when he says the PR is already merged.
//
//   2. IT NEEDS NO GOAL RECORD. `awaiting_close` is a state of `agentGoal`: it requires a goal, an
//      escalation, and landed work POSTDATING that goal. The rows this module is about frequently
//      have no goal at all — an agent that crashed after pushing, or that drew a permission prompt
//      nobody answered, never earned one. Requiring a goal here would make the veto unreachable
//      for precisely the population it exists to find, which is the mistake `blocked-on-human`
//      records having avoided ("Requiring an escalated goal here would have made this cause
//      unreachable for exactly the rows that never got one").
//
//   3. IT READS THE CROSS-REPO STAMP, WHICH NO GIT PROBE CAN. `engine/crossRepo`'s
//      {@link LandedElsewhere} — written by the `set_agent_landed` control op — is, in that
//      module's own words, "a TRUTH SOURCE the probe cannot reach": every landed-work probe in this
//      app resolves against the BOUND project worktree, so an agent whose work merged in another
//      repository reads as having landed nothing, forever, however finished it is. `awaiting-close`
//      is git-only and is structurally blind to that row.
//
// It is NARROW in the same way `awaiting-close` is, and the narrowness is likewise the half that
// matters: it fires ONLY on positively-proven landing. Every other red row is untouched.
//
// ── ⚠️ IT NAMES A STATUS TO PAINT WITH. IT NEVER REWRITES THE STATUS VALUE ───────────────────────
//
// `engine/stallEscalation.displayStatusFor` explains this at length and the constraint is repeated
// here because it is the one an integrator is most likely to break. Its first cut was a map overlay
// that rewrote the published status map, and it was wrong in a way this repo had already paid for
// once (roborev 53886): a dozen live consumers key on the literal status VALUE — the "Needs merge"
// label (`WorkerPeek`), `isOwedAction` / `accountedUnmerged` / `owedCounts.unmerged`
// (`conciergeFeed`), the digest's `unmerged` variant, `workerExpansion.isOwedAsk`, and both of
// `workerRollup`'s locks — and an overlay that floors the map makes a value unreachable for all of
// them, silently. In its own words: *"The status VALUE carries semantics other systems depend on.
// Only its COLOUR is what the founder was looking at."*
//
// So this returns a status to PAINT WITH and nothing else. `errored` stays `errored` in the map; it
// merely stops drawing the alarm colour. Whoever wires this up must feed it to the same rendering
// seam `displayStatusFor` feeds, never to the published status map.
//
// ── ⚠️ TWO THINGS AN INTEGRATOR MUST DECIDE, WHICH THIS MODULE DELIBERATELY DOES NOT ─────────────
//
//   (a) IT MUST NOT OUTRANK `awaiting-close`'s AMBER. That cause paints `lapsed` (amber) and its
//       comment is explicit about refusing calm gray: *"gray is the terminal 'shipped and closed'
//       state, and this row still owes a close."* This module paints `done`, which IS that terminal
//       gray. For a row where both are true, the amber must win — a row that still owes the founder
//       a bookkeeping close is not `done`, and letting this veto paint over it would quietly
//       reverse a decision taken on 2026-08-20 with its reasoning written down.
//
//   (b) `waiting` AND `approval` ARE THE UNCOMFORTABLE HALF OF THE RED SET, and this is stated so
//       nobody has to rediscover it. Those two mean an ON-SCREEN prompt is drawn right now — the
//       agent is asking a question or holding a permission dialog and will sit there until someone
//       answers, whatever its branch did. Landed work is not evidence that the question went away.
//       `errored` and `blocked` are the safe cases (a crashed or gone-quiet agent whose work is on
//       main genuinely has nothing left). The brief for this module names all four explicitly and
//       requires the set be DERIVED rather than hand-listed, so all four are implemented — but if a
//       founder ever reports a live prompt painted `done`, this paragraph is the one to overrule,
//       and the fix is a caller-side gate on "is a prompt currently drawn", not a narrower red set
//       here (narrowing the set would re-introduce the hand-written membership list rule 1 exists
//       to forbid).
//
// ── EVIDENCE, NOT INFERENCE ─────────────────────────────────────────────────────────────────────
//
// This repo's standing rule, stated on `escalationFor` and on `agentStall`'s header: an ABSENT
// reading never manufactures a verdict, because "a colour decision made on missing evidence is the
// false signal that trains the human to ignore the dot". Here it fails the SAFE way round — with no
// evidence, or with evidence that positively says NOT landed, the row STAYS RED. A veto that fired
// on ignorance would hide rows that really do need the founder, which is the one thing Sparkle's
// standing rule forbids outright.
//
// Pure — no React, no IPC, no store. Every rule here is unit-tested in `landedRedVeto.test.ts`.
import type { AGENT_STATUS, AgentTabStatus } from "@sparkle/ui";
import { isRedStatus, type RedStatus } from "../services/windowStatus";
// THE DEMONSTRATED-ASK PREDICATE, IMPORTED RATHER THAN RESTATED. It is the same set
// `blockedPromptGrace` consults for the same reason: a prompt that is DRAWN ON SCREEN is a
// different kind of fact from a status inferred by a timer, and only this module's own copy
// could drift from it. See the veto below for what it is doing here.
import { isDemonstratedAsk } from "./newAgentAttention";
import { stageFromLandedStamp, type LandedElsewhere } from "./crossRepo";
import { stageIndex, type WorkflowStageId } from "./workflowStage";
import type { WorkflowState } from "../services/branchStatus";

// ── The red set, DERIVED — twice, at runtime and at compile time ─────────────────────────────────

/**
 * The statuses this veto may repaint, derived FROM THE TOKEN TABLE'S RED HEX rather than listed.
 *
 * `AGENT_STATUS` is `as const`, so every `color` carries a literal type and the red tier is
 * expressible as a mapped type. That matters for the reason rule 1 of this module's brief gives: a
 * red status added to tokens.ts later must be covered automatically and must not be able to escape
 * the veto by being forgotten in a membership list here.
 */
type RedHex = (typeof AGENT_STATUS)["errored"]["color"];
export type DerivedRedStatus = {
  [K in AgentTabStatus]: (typeof AGENT_STATUS)[K]["color"] extends RedHex ? K : never;
}[AgentTabStatus];

type AssertTrue<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * A COMPILE-TIME PIN, and the reason this module does not hand-write the four literals.
 *
 * `services/windowStatus` is the one runtime red predicate and this module REUSES it rather than
 * writing a second copy — but the `RedStatus` subtype beside it is written by hand, and its own
 * comment warns that it "must stay in sync with the runtime color check (adding a red token to
 * tokens.ts means adding it here)". A warning in prose is exactly the shape that has failed in this
 * repo before: a fixture whose comment promised one thing while the code did another. This turns
 * that sentence into a TYPE ERROR — add a red-hex status to tokens.ts without adding it to
 * `RedStatus` and this alias stops compiling, right here, naming the drift.
 *
 * Exported so it is never an unused local; it has no runtime footprint.
 */
export type RedSetIsDerivedFromTokens = AssertTrue<Equal<RedStatus, DerivedRedStatus>>;

/**
 * The calm landing status this veto paints with — `done`, whose token reads "finished cleanly AND
 * landed — nothing left for you". That sentence is the exact claim proven landing licenses, which
 * is why this is `done` and not the amber `lapsed` ("Unfinished, not yours"): a row here is not
 * unfinished, its work is on a default branch.
 */
export const LANDED_PAINT = "done" as const satisfies AgentTabStatus;

// ── The evidence ─────────────────────────────────────────────────────────────────────────────────

/**
 * ONE LANDING SIGNAL'S READING. A TRI-STATE, NEVER A BOOLEAN.
 *
 * `false` and "we did not look" are different facts and collapsing them is precisely how a
 * not-observed reading becomes a silent "no" — the failure mode `agentStall`'s `unknown` verdict
 * and `rollupDot`'s null arm both exist to prevent, and the one `BranchStatus.dirtyNovelCount`
 * spells out over ten lines of comment. All three arms are meaningfully different here:
 *
 *   `landed`     — positively proven to have reached a default branch.
 *   `not-landed` — positively read, and it has NOT. A real answer, not an absence.
 *   `unknown`    — NOT OBSERVED. Never evidence of either. Identical in effect to omitting the
 *                  field, and spelled out so a caller can say "I looked and could not tell"
 *                  explicitly rather than having to drop the key.
 */
export type LandingReading = "landed" | "not-landed" | "unknown";

/**
 * Positive, checked evidence that this agent's work reached a default branch. Every field is
 * optional and `undefined` means NOT OBSERVED — never "no".
 *
 * TWO COMPLEMENTARY SIGNALS, and neither alone is enough — the same shape, and for the same reason,
 * as `engine/crossRepo`'s two halves. The bound-repo probe is blind to a foreign repository; the
 * stamp is self-reported and exists only where an agent bothered to write one.
 */
export interface LandedEvidence {
  /**
   * THE BOUND REPO'S OWN READING: is this agent's work on the project's default branch, or is its
   * PR merged? Derive it with {@link boundRepoLanding} rather than by hand.
   */
  boundRepo?: LandingReading;
  /**
   * THE CROSS-REPO STAMP: the `set_agent_landed` record, which `engine/crossRepo` calls "a TRUTH
   * SOURCE the probe cannot reach". Derive it with {@link crossRepoLanding} rather than by hand.
   *
   * SUFFICIENT ON ITS OWN, deliberately. That op exists precisely because no amount of looking at
   * the bound repo can reveal a PR in a different one, so demanding a bound-repo corroboration
   * would make the signal useless for every row it was written for.
   */
  crossRepo?: LandingReading;
}

/**
 * THE FIELD → READER TABLE, and it is a total `Record` ON PURPOSE.
 *
 * Keyed by `keyof LandedEvidence`, so ADDING A FIELD TO THE INTERFACE ABOVE AND FORGETTING IT HERE
 * IS A TYPE ERROR rather than a silent fall-through — a new signal cannot be added and then quietly
 * ignored by the check. This is the structural half of the same guarantee
 * {@link RedSetIsDerivedFromTokens} gives for the status set.
 */
const EVIDENCE_READERS: Record<keyof LandedEvidence, (e: LandedEvidence) => LandingReading> = {
  boundRepo: (e) => e.boundRepo ?? "unknown",
  crossRepo: (e) => e.crossRepo ?? "unknown",
};

/** Does ONE reading positively prove landing? Exhaustive, with a `never`-typed default arm so a new
 *  {@link LandingReading} arm is a type error here rather than falling through to a default. */
function readingProvesLanding(reading: LandingReading): boolean {
  switch (reading) {
    case "landed":
      return true;
    case "not-landed":
      // A REAL ANSWER, AND THE ANSWER IS NO. Distinct from `unknown` in meaning even though both
      // leave the row red: a caller reading this back can tell "we checked, it has not landed" from
      // "we never looked", which is the whole point of the tri-state.
      return false;
    case "unknown":
      return false;
    default: {
      const exhaustive: never = reading;
      return exhaustive;
    }
  }
}

/**
 * Does ANY field of this evidence positively prove landing?
 *
 * ANY, not ALL — the two signals answer the same question about different places, and requiring
 * both would mean a merged bound-repo PR could not clear a row unless the agent had ALSO stamped a
 * foreign repo it never touched. `undefined` evidence is `false` by the same evidence-not-inference
 * rule the header states.
 */
export function landingProven(evidence: LandedEvidence | undefined): boolean {
  if (evidence === undefined) return false;
  for (const read of Object.values(EVIDENCE_READERS)) {
    if (readingProvesLanding(read(evidence))) return true;
  }
  return false;
}

// ── Deriving the two readings from what the app already has ──────────────────────────────────────

/**
 * The bound-repo reading from a polled {@link WorkflowState}, or `unknown` when nothing was polled.
 *
 * ⚠️ PASS THE RAW POLL RESULT, AND `undefined` WHEN THERE ISN'T ONE. Do NOT route this through
 * `workflowStage.resolveStage` first: that FLOORS at the first rung rather than returning
 * `undefined`, so a caller who did would manufacture a positive "not landed" for a row nobody
 * polled. `displayStatusFor` records that exact trap ("…would manufacture a pre-terminal section
 * for a row nobody polled and paint the fleet amber on its own ignorance").
 *
 * ⚠️ `inLocalMain` IS NOT LANDING, and its omission is deliberate rather than an oversight.
 * `workflowStage.hasUnmergedCommittedWork` states the rule: "'main' here is ORIGIN main —
 * merged_local still counts as unmerged because the workflow lands via a PR to origin, so local-only
 * work still needs you to get it the rest of the way." A row on local main only genuinely still owes
 * the founder something, so it must stay red.
 */
export function boundRepoLanding(ws: WorkflowState | undefined): LandingReading {
  if (ws === undefined) return "unknown";
  if (ws.prState === "merged") return "landed";
  // `inOriginMain` is plain ancestry; `landedOnOrigin` is the patch-equivalence arm that catches a
  // squash/rebase landing, where the tip is an ancestor of nothing and ancestry alone reads false.
  // `shipped` sits above both — a tip contained in a published release tag. Any one of the three is
  // proof; none of them being true, on a reading that DID happen, is a real "not landed".
  if (ws.inOriginMain === true) return "landed";
  if (ws.landedOnOrigin === true) return "landed";
  if (ws.shipped === true) return "landed";
  return "not-landed";
}

/**
 * The cross-repo reading from a `set_agent_landed` stamp, or `unknown` when the agent wrote none.
 *
 * DELEGATES THE LADDER RULE TO {@link stageFromLandedStamp} rather than re-reading `state` itself,
 * so the "absent state floors at `pushed`, NOT `merged`" rule lives in exactly one place. That rule
 * is the reason the middle arm below is `unknown` and not `not-landed`: a bare `{ repo }` stamp
 * establishes that the work reached a remote repository and NOTHING MORE, so it is silence about
 * the merge, not a denial of it. Reading it as a denial would be inventing a status just as much as
 * reading it as a merge would — the failure `crossRepo` exists to end, pointed the other way.
 */
export function crossRepoLanding(stamp: LandedElsewhere | undefined): LandingReading {
  if (stamp === undefined) return "unknown";
  // `>= merged` rather than a literal pair, so `shipped` — and any future rung above it — counts
  // without this line having to be revisited.
  if (stageIndex(stageFromLandedStamp(stamp)) >= stageIndex("merged")) return "landed";
  if (stamp.state === undefined) return "unknown";
  // The agent stated `open` or `closed`: a real answer, and it is not a landing.
  return "not-landed";
}

// ── The veto ─────────────────────────────────────────────────────────────────────────────────────

/**
 * THE STATUS TO PAINT WITH, or `undefined` meaning "leave this row exactly as it is".
 *
 * Returns {@link LANDED_PAINT} only when BOTH halves hold, and each half fails closed:
 *   1. `status` is in the RED tier — asked of `windowStatus.isRedStatus`, which asks the token
 *      table for the red hex. A non-red row is none of this module's business; a calm row with
 *      landed evidence is left alone, because repainting `idle` → `done` is a different decision
 *      made by a different surface.
 *   2. Landing is POSITIVELY PROVEN by at least one evidence field. Absent evidence, and evidence
 *      that positively says NOT landed, both leave the row red — see the header's
 *      evidence-not-inference paragraph for why that asymmetry is the safe direction.
 *
 * It never rewrites the status value; see the header.
 */
export function landedRedVetoFor(
  status: AgentTabStatus | undefined,
  evidence: LandedEvidence | undefined,
): AgentTabStatus | undefined {
  if (!isRedStatus(status)) return undefined;
  // ── A DEMONSTRATED ASK IS NOT DISCHARGED BY A LANDING ────────────────────────────────────────
  //
  // `waiting` and `approval` mean a prompt is DRAWN ON SCREEN right now. An agent whose PR merged
  // and which is then sitting at a fresh permission prompt still CANNOT PROCEED without a person,
  // so the landing says nothing about it: the merge discharged the WORK, and the prompt is a fact
  // about the AGENT. Demoting here would hide a live ask behind a landing that has nothing to do
  // with it — the exact inversion of the rule this module exists to serve, which colours on whether
  // work is STOPPED rather than on what the row has achieved.
  //
  // ⚠️ THIS GUARD IS INSIDE THE FUNCTION, NOT AT THE CALL SITE, AND THAT IS DELIBERATE. Narrowing
  // where it happens to be called would leave the next caller free to reintroduce the bug, and this
  // is a predicate whose whole value is that it can be trusted anywhere. `isRedStatus` deliberately
  // stays the outer gate so the RedStatus type-level derivation above keeps its meaning: a red
  // status added to the token table is still forced through here, and still has to be classified.
  if (isDemonstratedAsk(status)) return undefined;
  if (!landingProven(evidence)) return undefined;
  return LANDED_PAINT;
}

// ── The overlay ──────────────────────────────────────────────────────────────────────────────────

/**
 * Overlay the landed veto onto every row it applies to.
 *
 * ── WHY AN OVERLAY AND NOT A PAINT-ONLY RECOLOUR ───────────────────────────────────────────────
 * The first design here was paint-only, on the belief that rewriting the status VALUE would starve
 * `services/apiRecoveryRunner`, which gates its retry on `status === "errored"`. That belief was
 * WRONG and worth recording so it is not re-derived: the runner reads
 * `useRuntimeStore.getState().status[id]` — the RAW published store — while this and every sibling
 * overlay produce DERIVED, per-render maps that are never written back. Nothing in the recovery path
 * can see this function at all.
 *
 * The real constraint is the narrower one roborev 53886 recorded: an overlay rewrite is visible to
 * the consumers OF THAT MAP, so a value they key on can be made unreachable. Here that is not merely
 * acceptable but correct — a row whose work is proven landed genuinely IS `done`, which is what the
 * bands, the ordering and the owed counts should all be reading.
 *
 * Same shape as `withDeadSessionCalm` and every other overlay in this chain: returns the SAME
 * reference when nothing changes, and never mutates its input.
 *
 * ── PLACEMENT ─────────────────────────────────────────────────────────────────────────────────
 * BEFORE the worker bubbles, for the reason `deadSessionAttention` gives: once a red has bubbled to
 * an orchestrator head, an inherited red is indistinguishable from an own red, and a head would go
 * on wearing an alarm about a worker whose work is already on main.
 */
export function withLandedRedVeto<T extends { id: string; landedElsewhere?: LandedElsewhere }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  stageOf: (id: string) => WorkflowStageId | undefined,
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  for (const a of agents) {
    const evidence = landedEvidenceFor(stageOf(a.id), a.landedElsewhere);
    const to = landedRedVetoFor(statusMap[a.id], evidence);
    if (to === undefined) continue;
    (out ??= { ...statusMap })[a.id] = to;
  }
  return out ?? statusMap;
}

/**
 * Assemble one agent's {@link LandedEvidence} from the two readings BOTH chains can actually reach.
 *
 * ── WHY THE STAGE AND NOT `WorkflowState` ──────────────────────────────────────────────────────
 * {@link boundRepoLanding} reads a `WorkflowState`, which is the richer signal — but it is FETCHED
 * TRANSIENTLY by `runtimeStore.applyWorkflowState` and never stored per agent, so no status chain
 * holds one. What both chains hold is the resolved STAGE: the sidebar derives it from
 * `resolveStage(branchStatus[id], workflowStage[id])`, and `publishedStatusFor` already takes a
 * `stageOf` parameter of exactly that shape.
 *
 * That difference is load-bearing rather than incidental. `useAttentionNotifications` DELIBERATELY
 * stopped subscribing to `branchStatus` (roborev 46897: it takes a fresh object identity on every
 * poll, so the subscription re-ran the whole notification effect per branch poll). Reaching for the
 * richer signal here would have meant re-adding that subscription and silently undoing a measured
 * performance decision — so the evidence is taken at the shape both chains ALREADY have, which is
 * the only way one function can serve both without one of them paying for it.
 */
export function landedEvidenceFor(
  stage: WorkflowStageId | undefined,
  stamp: LandedElsewhere | undefined,
): LandedEvidence {
  return { boundRepo: stageLanding(stage), crossRepo: crossRepoLanding(stamp) };
}

/**
 * The bound repo's landing, read off the resolved workflow stage.
 *
 * ⚠️ ITS NEGATIVE ARM IS `unknown`, NOT `not-landed`, AND THAT IS THE HONEST ANSWER RATHER THAN THE
 * CAUTIOUS ONE. `resolveStage` FLOORS at the first rung for a row nobody polled instead of returning
 * `undefined` — the trap `stallEscalation.displayStatusFor` records — so a pre-`merged` stage cannot
 * be told apart from "this window never read the git state". Calling that `not-landed` would be
 * manufacturing a positive reading out of ignorance, which is the specific failure
 * {@link LandingReading}'s three arms exist to prevent. Both arms leave the row RED either way, so
 * nothing behavioural turns on it here; the label still has to tell the truth, because the next
 * caller may not be a veto that fails safe in the same direction.
 */
export function stageLanding(stage: WorkflowStageId | undefined): LandingReading {
  if (stage === undefined) return "unknown";
  return stageIndex(stage) >= stageIndex("merged") ? "landed" : "unknown";
}
