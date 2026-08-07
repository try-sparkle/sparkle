// IS THIS AGENT READY TO BE RETIRED, AND CAN IT STILL ANSWER IF NOT?
//
// The founder's ask: *"an informational pill, kind of like the plan pill… that would say that
// you're recommending that the agent be fully retired because it is done and the feedback has been
// completed and logged."*
//
// ── THIS ADDS NO ATTENTION STATE, AND THAT IS HOW IT EARNS ITS PLACE ─────────────────────────────
// `engine/workerRollup.ts` warns twice in its header that the attention taxonomy has drifted twice
// before, and `components/rowAttention.ts:16-18` states the rule outright: *"NO NEW STATUS.
// Everything here is a derived OVERLAY read ALONGSIDE `AgentTabStatus`, exactly as `rollupDot` sits
// beside `status`."* So this module adds no `AgentTabStatus`, no `StatusBand`, no `RollupDot`, no
// filter chip and no colour token. The row keeps the status and the dot it already had; this is a
// second, independent thing the row can also say.
//
// That is not a technicality — it is the founder's requirement, restated in the taxonomy's own
// terms. He asked for something *informational*, explicitly not the needs-you red. Anything routed
// through `bandOfStatus` would land in one of exactly three bands: `needs_you` (which the concierge
// digest COUNTS and the filter chip narrows — the false "N agents need you" that `buildSections.ts`
// warns about) or `done`/`running`, where it would be invisible. Neither is a pill. Staying out of
// the taxonomy is the only way to be visible without being an alarm.
//
// ── WHY `merged` IS THE THRESHOLD, NOT `shipped` ─────────────────────────────────────────────────
// The founder settled this: *"It's fine that it happens at Merge State vs. Shipped State. Let's
// just make sure that it EXISTS before the agent is retired."* Retro capture already fires at merge
// (scripts/capture-merge-retro.sh is a `gh pr merge` hook), so `merged` is where a retro can first
// be expected to exist. Waiting for `shipped` would leave the whole merged-but-unreleased population
// — most of the list at any moment — with nothing said about it.
import { stageIndex, type WorkflowStageId } from "./workflowStage";
import { retroSettled, type RetroReceipt } from "./retroReceiptTypes";
import type { AgentTabStatus } from "../types";

/** What the row's retirement pill says, or `null` for no pill at all.
 *
 *  `null` is the common case and it matters: a row that is still working, or is not a build agent,
 *  must offer nothing here. A pill that renders on every row is chrome, not signal — and the epic
 *  pill's own precedent (`services/planView.epicPillFor` returns `null` to hide) is that a chip
 *  with nothing to say does not render, so no dead click can exist. */
export type RetirementPill =
  /** Done, landed, and its retro is on file. Retirement RECOMMENDED — informational, never red. */
  | "ready"
  /** Landed, but the retro step is not complete. Also calm: the Pusher is already asking for it,
   *  and nothing here is blocked on the human. */
  | "retro-pending"
  | null;

/** Everything the pill decision reads. A plain record rather than an `AgentTab` so this stays
 *  testable without constructing a whole agent, and so a caller cannot accidentally make the
 *  decision depend on a field nobody thought about. */
export interface RetirementInput {
  kind: string;
  stage: WorkflowStageId;
  /** The agent's completed retro step, or absent when there is none on file.
   *
   *  `null` AND `undefined` both mean absent, and both must be accepted: the receipt is read across
   *  the Tauri boundary, where a Rust `Option::None` becomes JSON `null` and never `undefined`
   *  (roborev 58719). This decision goes through `retroSettled`, which owns that check. */
  receipt: RetroReceipt | null | undefined;
}

/**
 * The pill for one row. Pure.
 *
 * Deliberately does NOT consult the agent's `AgentTabStatus`. A merged build agent that happens to
 * be `working` (a follow-up task, a review lap) has still landed work whose retro is owed or filed,
 * and hiding the pill while it is busy would make the state flicker with the PTY. Liveness matters
 * only for whether it can ANSWER — see `canAnswerRetroPing`.
 */
export function retirementPill({ kind, stage, receipt }: RetirementInput): RetirementPill {
  // Workers report to their orchestrator, not to the founder's build list, and a shell has no
  // branch and no retro to give. Only build agents occupy a row he retires.
  if (kind !== "build") return null;
  // Nothing has landed, so nothing is owed. This also keeps the pill off every actively-building
  // row, which is most of the column most of the time.
  if (stageIndex(stage) < stageIndex("merged")) return null;
  // Through `retroSettled`, never a local `=== undefined`: absence arrives from Rust as `null`, and
  // a second hand-rolled absence check is exactly how the two would drift (roborev 58719).
  return retroSettled(receipt) ? "ready" : "retro-pending";
}

/** Is retirement RECOMMENDED for this row — i.e. would the pill read "ready"?
 *
 *  A named predicate rather than `=== "ready"` at each call site, because three surfaces ask this
 *  (the pill, the confirm dialog's wording, and the Pusher snapshot) and a fourth will be added by
 *  someone who does not read this file. */
export function retirementRecommended(input: RetirementInput): boolean {
  return retirementPill(input) === "ready";
}

/** Statuses from which an agent cannot be expected to answer anything.
 *
 *  `stopped` is a dead session; `errored` is one that crashed or hit a wall it cannot pass. Both are
 *  states the app itself put the row into, so this is a reading rather than an inference. */
const UNREACHABLE_STATUSES: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["stopped", "errored"]);

/**
 * Can this agent still be asked for its retro?
 *
 * WHAT IT GOVERNS, AND WHAT IT NO LONGER DOES (roborev 59423). It selects the confirm dialog's
 * WORDING — "it may still be reachable" vs "it can't be asked" — and nothing else. It used to gate
 * the human override itself: the retire action was withheld while this answered `true`, so that
 * retirement could not record a "could not be asked" claim about an agent that was being asked.
 * That was reversed, because this is NOT a liveness reading. An `undefined` status answers `true`
 * (below), and `runtimeStore.status` is written by exactly one thing — a mounted `AgentPane` — so
 * after a relaunch, or for any project not currently hosted in a column, EVERY landed row read as
 * reachable and had no exit from the build list at all. The receipt no longer makes the claim that
 * justified the gate either; it records only that nothing was on file at the time. Do not re-add
 * the suppression: leaving rows unretireable is the failure mode the override exists to prevent.
 *
 * FAIL-CLOSED TOWARD ASKING. An `undefined` status means the runtime has not reported yet, not that
 * the agent is dead, so it answers `true` and the agent gets pinged. The cost of being wrong that
 * way is one unanswered ping; the cost of being wrong the other way is offering a human an override
 * — a recorded gap in the feedback record — for an agent that was about to reply.
 */
export function canAnswerRetroPing(
  status: AgentTabStatus | undefined,
  /** True when the agent is walled behind an account/quota limit (engine/quotaBlock,
   *  engine/engineRegistry.quotaBlockForAgent). It may be `working` and still unable to answer. */
  quotaBlocked = false,
): boolean {
  if (quotaBlocked) return false;
  if (status === undefined) return true;
  return !UNREACHABLE_STATUSES.has(status);
}
