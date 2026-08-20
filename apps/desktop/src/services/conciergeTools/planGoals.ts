// planGoals — the concierge's half of goals on epics (bead `sparkle-wab4lm`).
//
// "A plan IS an epic bead" (see plans.ts), so these are ops on the PLANS domain rather than a new
// domain of their own: the founder says "change the goal on <epic> to X", and the thing he names is
// the same thing `list_plans` already lists. A second domain would give the model two vocabularies
// for one object, which is the confusion this whole feature is trying not to add to.
//
// They live in their OWN FILE only to keep the diff off `plans.ts`, which another branch is editing.
// The op names, their risk classification, and the routes stay in the places every other op's do.
//
// ── WHY `set_plan_goal` WRITES `source: "human"` ──────────────────────────────────────────────
// It is the concierge acting on an instruction — "change the goal on X to Y" is the founder's
// wording relayed through a model, not a machine's opinion — so it stamps the permanent latch that
// stops automatic regeneration.
//
// ⚠️ A GENERATION OP MUST NOT COPY THIS (roborev 65853). `source` is the field that satisfies the
// founder's constraint that an auto-written goal be VISIBLY DISTINGUISHABLE from one he wrote, and
// `newEpicGoal` stamps the latch for every `"human"` write. So a generation path claiming `"human"`
// would both suppress the auto badge and latch the epic against its own future regeneration. It
// writes `"auto"` and beats the latch with `force` — a person asking for a regenerate is a person
// choosing to spend the call — never by claiming to be the person.
import { epicGoalTextRejection, epicVerifyOf, hasEpicGoalText } from "../../engine/epicGoal";
import { beadShow, isBeadsUnavailable, isEpic, listBeads } from "../beads";
import { useProjectStore } from "../../stores/projectStore";
import { epicGoalGenDeps, requestEpicGoal, type EpicGoalGenOutcome } from "../epicGoalGen";
import { GOAL_MAX_LEN, GOAL_MIN_LEN, parseGoalVerify, type GoalVerify } from "@sparkle/core";
import type { PlansOp, PlansResult, PlansRisk } from "./plans";

/** Mirrors `plans.ts`'s private helpers. Duplicated rather than exported from there, again to keep
 *  this branch's diff off that file; the shapes are structural, so a drift fails `tsc` here. */
function ok<T>(op: PlansOp, risk: PlansRisk, data: T): PlansResult<T> {
  return { ok: true, op, risk, data };
}
function refuse(op: PlansOp, risk: PlansRisk, reason: string, message: string): PlansResult<never> {
  return { ok: false, op, risk, reason, message };
}

export interface PlanGoalView {
  epicId: string;
  title: string;
  goal: string | null;
  source: "auto" | "human" | null;
  verify: GoalVerify | null;
  /** Was this goal last written by a person? Once true it stays true — the machine will not
   *  regenerate over it unless someone explicitly asks. */
  humanEdited: boolean;
}

/** Resolve the epic and REFUSE if the id is not one. Shared by both ops so a task id cannot acquire
 *  an epic goal through whichever op happened to check less. */
async function resolveEpic(
  op: PlansOp,
  risk: PlansRisk,
  projectPath: string,
  epicId: string,
): Promise<PlansResult<{ id: string; title: string }>> {
  try {
    const [epic, beads] = await Promise.all([beadShow(projectPath, epicId), listBeads(projectPath)]);
    // Written as explicit comparisons rather than `!epic` / `!isEpic(...)` so each guard is a line a
    // mutation check can actually invert. A guard no tool can express a mutant for is a guard whose
    // coverage is asserted only by the fact that a test happened to pass.
    const missing = epic === null || epic === undefined;
    if (missing === true) {
      return refuse(op, risk, "no-such-plan", `There is no bead ${epicId} in this project.`);
    }
    if (isEpic(beads, epic) !== true) {
      return refuse(
        op,
        risk,
        "not-a-plan",
        `${epicId} is a ${epic.type ?? "task"}, not a plan. Goals are set on epics; a task's ` +
          `objective is the goal of the agent that builds it.`,
      );
    }
    return ok(op, risk, { id: epic.id, title: epic.title });
  } catch (e) {
    if (isBeadsUnavailable(e) === true) {
      return refuse(
        op,
        risk,
        "beads-unavailable",
        "This project doesn't have a beads database (or `bd` isn't installed), so it has no plans.",
      );
    }
    return refuse(op, risk, "beads-failed", e instanceof Error ? e.message : String(e));
  }
}

/** Read an epic's goal as the concierge sees it. */
export function readPlanGoal(
  projectId: string,
  epicId: string,
  title: string,
): PlanGoalView {
  const rec = useProjectStore.getState().projects.find((p) => p.id === projectId)?.epicGoals?.[
    epicId
  ];
  return {
    epicId,
    title,
    goal: hasEpicGoalText(rec) ? rec.text : null,
    source: hasEpicGoalText(rec) ? rec.source : null,
    verify: rec?.verify ?? null,
    humanEdited: rec?.humanEditedAt !== undefined,
  };
}

/**
 * "Change the goal on <epic> to X" — and "clear the goal on <epic>", which is an empty `goal`.
 *
 * Writes `source: "human"`: see the header. The store applies the same text floor the worker-goal
 * gate uses, but the refusal is produced HERE so the concierge gets a sentence it can relay rather
 * than a silent no-op — the store's own floor is the substrate every caller shares and cannot know
 * who is asking.
 */
export async function setPlanGoal(
  op: PlansOp,
  risk: PlansRisk,
  projectPath: string,
  projectId: string,
  epicId: string,
  goal: string,
  verify?: GoalVerify,
): Promise<PlansResult<PlanGoalView>> {
  const found = await resolveEpic(op, risk, projectPath, epicId);
  if (!found.ok) return found;

  const trimmed = goal.trim();
  if (trimmed !== "") {
    const rejection = epicGoalTextRejection(trimmed);
    if (rejection !== null) {
      return refuse(
        op,
        risk,
        "unusable-goal",
        `That goal is ${rejection}. A goal names the OBSERVABLE END STATE — what will be true when ` +
          `the epic is achieved and how anyone could check it — in ${GOAL_MIN_LEN}–${GOAL_MAX_LEN} ` +
          `characters. To remove the goal instead, pass an empty one.`,
      );
    }
  }
  // VALIDATE, DO NOT TRUST (roborev 65867). `epicVerifyOf` checks the KIND and nothing else, so
  // `{ kind: "command" }` with no `cmd` — or a blank one — used to be stored verbatim as an
  // unrunnable check. The generator path never could: it runs `parseGoalVerify` first. This was the
  // one entry point where a malformed verify reached the store, and a cast at the route was what
  // silenced the type error that would otherwise have said so.
  if (verify !== undefined) {
    const verdict = parseGoalVerify(verify);
    if (!verdict.ok) return refuse(op, risk, "unusable-verify", verdict.message);
  }
  // `landed` is silently narrowed to `human` rather than refused: an epic is not a branch, so
  // ancestry could never answer it, and refusing would make the concierge retry a check that can
  // never apply. `epicVerifyOf` is the one place that rule lives.
  useProjectStore.getState().setEpicGoal(projectId, epicId, trimmed, "human", epicVerifyOf(verify));
  return ok(op, risk, readPlanGoal(projectId, epicId, found.data.title));
}

/**
 * "Write me a goal for that epic" / "regenerate it".
 *
 * ALWAYS `force: true`. This op only exists because a person asked, and the latch's whole contract
 * is that an explicit human ask is the one thing that beats it — without `force` the op would be a
 * silent no-op on precisely the epics someone bothers to ask about (a goal already filled, or one
 * they wrote themselves and now want redone), and a tool that quietly does nothing is worse than
 * one that refuses.
 *
 * Note it writes `source: "auto"` (inside the generator), NEVER `"human"`: see the header. The
 * person chose to SPEND the call; they did not write the words.
 *
 * Every outcome is reported as a REFUSAL rather than an error, because none of them is a fault —
 * they are the safety rules working, and each one has something the caller can say back.
 */
export async function generatePlanGoal(
  op: PlansOp,
  risk: PlansRisk,
  projectPath: string,
  projectId: string,
  epicId: string,
): Promise<PlansResult<PlanGoalView>> {
  const found = await resolveEpic(op, risk, projectPath, epicId);
  if (!found.ok) return found;

  let outcome: EpicGoalGenOutcome;
  try {
    outcome = await requestEpicGoal(epicGoalGenDeps, {
      projectId,
      projectPath,
      epicId,
      force: true,
    });
  } catch (e) {
    // `requestEpicGoal` records its own failures in the store and resolves rather than throwing, so
    // reaching here means something outside it broke. Still a refusal, never a written goal.
    return refuse(op, risk, "generation-failed", e instanceof Error ? e.message : String(e));
  }

  if (outcome === "generated") return ok(op, risk, readPlanGoal(projectId, epicId, found.data.title));
  if (outcome === "ai-off") {
    return refuse(
      op,
      risk,
      "ai-off",
      "AI features are switched off for this project, so I can't write a goal. Turn them on in " +
        "settings, or tell me the goal and I'll set it.",
    );
  }
  if (outcome === "in-flight") {
    return refuse(
      op,
      risk,
      "already-generating",
      `A goal for ${epicId} is already being written. It will appear on the epic when it lands.`,
    );
  }
  if (outcome === "latched") {
    // Not reachable with `force: true` today, and handled anyway rather than folded into the
    // failure arm: a silent misreport here would be indistinguishable from a model timeout, and
    // the two need opposite things said to the caller.
    return refuse(
      op,
      risk,
      "latched",
      `${epicId} already has a goal that shouldn't be overwritten automatically.`,
    );
  }
  return refuse(
    op,
    risk,
    "generation-failed",
    "I couldn't write a usable goal for that epic, so I left it empty rather than guess. Tell me " +
      "the goal and I'll set it, or ask me to try again.",
  );
}
