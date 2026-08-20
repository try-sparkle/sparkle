// The PLANS domain — the Plan side of the Plan/Build toggle.
//
// Before this, the Plan column was completely unreachable: `navigate` could open the view and that
// was the whole of it. The concierge could not see what plans existed, could not create one, and
// could not promote one into a build — so every planning conversation ended with the human doing
// the mechanical part.
//
// A "plan" IS AN EPIC BEAD. There is no separate plan store: the Plan board renders bd epics with
// their child tasks, and `services/planView.ts` already computes every derived fact the board shows
// (a child's stage, an epic's rolled-up status, which workers are attached to a bead, which
// orchestrator owns an epic). This domain is a THIN READ over those helpers plus two writes — it
// deliberately re-derives nothing, because a second implementation of "what stage is this child in"
// would drift from the one the human is looking at.
//
// PROMOTION DELEGATES, IT DOES NOT FORK. `promote_plan_to_build` hands off through
// `services/sendToBuild`, the same path the board's own "Start" / "Build It" buttons take. That
// function is also the one place that enforces ONE ORCHESTRATOR PER EPIC (it reuses a build agent
// already bound to this epic rather than starting a second one), so routing around it would quietly
// break that invariant.
import {
  listBeads,
  beadShow,
  blockedBeadIds,
  childrenOf,
  isEpic,
  isBeadsUnavailable,
  type Bead,
} from "../beads";
import {
  CREATE_PLAN_DEDUPE_BUDGET_MS,
  CREATE_PLAN_TOTAL_BUDGET_MS,
  DEADLINE_EXPIRED,
  beadsCreate,
  beadsQuery,
  withDeadline,
  withDeadlineOrExpired,
  isBdMissing,
  isNoWorkspace,
  isWriteDropped,
  toBeadsError,
  type BeadsError,
} from "../beadsCommands";
import { epicStatus, epicChildViews, orchestratorNameForEpic } from "../planView";
import { columnFor } from "../beads";
import { sendToBuild, AtCapacityError } from "../sendToBuild";
import { epicGoalGenDeps, requestEpicGoal } from "../epicGoalGen";
import { useProjectStore } from "../../stores/projectStore";
import { log } from "../../logger";
import type { AgentTab } from "../../types";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const PLANS_OPS = [
  "list_plans",
  "get_plan",
  "create_plan",
  "promote_plan_to_build",
  // Goals on epics (bead `sparkle-wab4lm`). Ops on the PLANS domain rather than a domain of their
  // own because a plan IS an epic bead: the founder says "change the goal on <epic> to X", and the
  // thing he names is what `list_plans` already lists. The bodies live in ./planGoals.
  "set_plan_goal",
  "generate_plan_goal",
] as const;

export type PlansOp = (typeof PLANS_OPS)[number];

export type PlansRisk = "read-only" | "routine" | "disruptive" | "irreversible";

/**
 * EXHAUSTIVE by construction — a `Record<PlansOp, …>`, so an op added to `PLANS_OPS` without a
 * classification fails `tsc` rather than defaulting to something permissive.
 *
 * `promote_plan_to_build` is `routine`, not `disruptive`: it creates (or reuses) a local build agent
 * and seeds it, which is the same cost as `spawn_build_agent` and equally undoable by closing the
 * agent. It is NOT free — it consumes an agent slot — and the machine-wide cap is enforced inside
 * `sendToBuild`, on the shared path, so every caller of it is gated rather than just this one.
 * But it destroys nothing.
 */
export const PLANS_RISK: Record<PlansOp, PlansRisk> = {
  list_plans: "read-only",
  get_plan: "read-only",
  create_plan: "routine",
  promote_plan_to_build: "routine",
  // `routine`, not `disruptive`: setting a goal writes one field in the app's own store and is
  // undone by setting it again. It is NOT read-only — it stamps the permanent human latch that
  // stops auto-regeneration, which is a real and deliberate consequence.
  set_plan_goal: "routine",
  // Same class, and it SPENDS: it is a paid model call. Bounded to one epic per call, refused by
  // the AI gate and by the in-flight dedupe, and it can never overwrite a human's wording without
  // that person having asked for exactly this.
  generate_plan_goal: "routine",
};

// ---------------------------------------------------------------------------------------------
// Results — the lifecycle/board convention
// ---------------------------------------------------------------------------------------------

export interface PlansOk<T> {
  ok: true;
  op: PlansOp;
  risk: PlansRisk;
  data: T;
}

export interface PlansRefusal {
  ok: false;
  op: PlansOp;
  risk: PlansRisk;
  reason: string;
  message: string;
}

export type PlansResult<T> = PlansOk<T> | PlansRefusal;

function ok<T>(op: PlansOp, data: T): PlansOk<T> {
  return { ok: true, op, risk: PLANS_RISK[op], data };
}

function refuse(op: PlansOp, reason: string, message: string): PlansRefusal {
  return { ok: false, op, risk: PLANS_RISK[op], reason, message };
}

/** Same failure split as the board domain: a project with no `bd` database is a SUPPORTED state, not
 *  an error, so it gets its own refusal instead of surfacing as an internal error the concierge
 *  would go hunting for. */
async function attempt<T>(op: PlansOp, run: () => Promise<T>): Promise<PlansResult<T>> {
  try {
    return ok(op, await run());
  } catch (e) {
    if (isBeadsUnavailable(e)) {
      return refuse(
        op,
        "beads-unavailable",
        "This project doesn't have a beads database (or `bd` isn't installed), so it has no plans. " +
          "Run `bd init` in the project to start one.",
      );
    }
    return refuse(op, "beads-failed", e instanceof Error ? e.message : String(e));
  }
}

// Epic-ness is NOT decided here. `services/beads.ts` owns the one resolver (see the "Epic
// membership" section there); this module used to test the type field on its own, which is one
// of the three competing conditions that made eight real parents — typed feature/bug/task, 2 to 19
// children apiece — invisible to `list_plans`.

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

/** One plan as the concierge sees it: the epic, its rolled-up status, and who is building it. */
export interface PlanSummary {
  id: string;
  title: string;
  description: string;
  /** unplanned | planning | in_progress | done — rolled up from the children by planView.
   *
   *  `planning` is the one the concierge should react to: it means the plan is WRITTEN and nobody
   *  has started it. `unplanned` means the epic has no children at all, so there is nothing to
   *  promote yet — offering to build one would hand a build agent an empty brief. */
  status: ReturnType<typeof epicStatus>;
  childCount: number;
  /** The build agent bound to this epic, when one exists. Null means nobody is on it yet — which is
   *  exactly the state `promote_plan_to_build` changes. */
  orchestrator: string | null;
}

/**
 * A child task, with the facts the Plan board shows that the raw bead does not carry.
 *
 * Deliberately NO per-child build `stage`. `planView.beadStage` needs the live worker stages out of
 * the RUNTIME store, and planView's own comment says that layer is "layered on by the view" — so
 * computing it here would be a second derivation of something the view owns, and it would drift.
 * `column` is the same lane the board reports (`columnFor`), which is a fact about the bead itself.
 */
export interface PlanChildView {
  id: string;
  title: string;
  status: Bead["status"];
  /** The board column this child sits in — shared with the board domain, so the two agree. */
  column: ReturnType<typeof columnFor>;
  blocked: boolean;
  /** Names of the worker agents attached to this bead. */
  workers: string[];
}

/** The agents of one project, as planView's pure helpers want them. Resolved from the STORE here —
 *  planView takes data, not ids, precisely so it stays pure and testable. */
function agentsOf(projectId: string): AgentTab[] {
  return useProjectStore.getState().projects.find((p) => p.id === projectId)?.agents ?? [];
}

function summarize(epic: Bead, all: Bead[], agents: AgentTab[]): PlanSummary {
  return {
    id: epic.id,
    title: epic.title,
    description: epic.description,
    status: epicStatus(all, epic.id),
    childCount: childrenOf(all, epic.id).length,
    orchestrator: orchestratorNameForEpic(all, agents, epic.id),
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Every plan in the project, each with its rolled-up status and orchestrator. */
export async function listPlans(
  projectPath: string,
  projectId: string,
): Promise<PlansResult<PlanSummary[]>> {
  return attempt("list_plans", async () => {
    const beads = await listBeads(projectPath);
    const agents = agentsOf(projectId);
    return beads.filter((b) => isEpic(beads, b)).map((e) => summarize(e, beads, agents));
  });
}

/**
 * One plan with its children.
 *
 * Returns null for an id the project does not hold, and refuses for an id that IS a bead but is not
 * an epic — those are different mistakes and a model retrying needs to tell them apart.
 */
export async function getPlan(
  projectPath: string,
  projectId: string,
  id: string,
): Promise<PlansResult<{ plan: PlanSummary; children: PlanChildView[] } | null>> {
  const found = await attempt("get_plan", async () => {
    const [epic, beads, blocked] = await Promise.all([
      beadShow(projectPath, id),
      listBeads(projectPath),
      blockedBeadIds(projectPath),
    ]);
    return { epic, beads, blocked };
  });
  if (!found.ok) return found;
  const { epic, beads, blocked } = found.data;
  if (!epic) return ok("get_plan", null);
  if (!isEpic(beads, epic)) {
    return refuse(
      "get_plan",
      "not-a-plan",
      `${id} is a ${epic.type ?? "task"}, not a plan. Use the board tools to read an individual task.`,
    );
  }
  const agents = agentsOf(projectId);
  return ok("get_plan", {
    plan: summarize(epic, beads, agents),
    // epicChildViews pairs each child with the workers on it — the Plan board's own composition,
    // reused rather than rebuilt.
    children: epicChildViews(beads, agents, epic.id).map(({ bead, workers }) => ({
      id: bead.id,
      title: bead.title,
      status: bead.status,
      column: columnFor(bead, blocked),
      blocked: blocked.has(bead.id),
      workers,
    })),
  });
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** What a `create_plan` actually did. Two SUCCESS outcomes, because "there is already an epic for
 *  this" is not a failure — the user gets a working id either way and the concierge must not report
 *  a second card that it did not file. */
export type CreatePlanOutcome = "created" | "already-filed";

export interface CreatedPlan {
  id: string;
  title: string;
  outcome: CreatePlanOutcome;
}

/**
 * WHAT A FAILED CREATE PROVES — three answers, not one, and the difference is the whole point.
 *
 * The old path collapsed every failure onto `beads-failed`, which reads to a model as "nothing
 * happened". That is a guess dressed as a fact: the store is one embedded Dolt database shared by
 * every worktree and polled every 5s, so the ORDINARY failure here is losing a race, and a create
 * killed on its own timeout may very well have landed. Telling the user nothing was filed and
 * retrying produces two epics for one idea — the exact duplicate `alreadyFiledId` below exists to
 * prevent, manufactured by the error handler.
 *
 *   `unavailable`  bd is missing or the project has no work graph. A supported state, not a fault.
 *   `not-created`  PROVEN nothing was filed. Safe to retry unchanged.
 *   `unknown`      Genuinely unresolved. Do NOT retry blind; read the plan list first.
 *
 * Only two things prove absence, and both are narrow on purpose. `invalidInput` is rejected in Rust
 * before bd is ever invoked. `isWriteDropped` fires only when the post-create probe RAN CLEANLY and
 * found no row — a probe that could not run fails OPEN in `confirm_written`, precisely so an
 * unreadable probe can never condemn a create that landed. Everything else is `unknown`, which is
 * the fail-safe direction: over-reporting "unknown" costs one extra read, over-reporting
 * "not-created" costs a duplicate epic.
 *
 * Pure and exported so this can be tested against every kind without a bd that fails on cue.
 */
export function createFailureVerdict(e: unknown): "unavailable" | "not-created" | "unknown" {
  if (isNoWorkspace(e) || isBdMissing(e)) return "unavailable";
  if (isWriteDropped(e)) return "not-created";
  if (toBeadsError(e).kind === "invalidInput") return "not-created";
  return "unknown";
}

/** Normalized for comparison only — case and inner whitespace, which is all a model varies when it
 *  re-files the same idea a minute later. Deliberately NOT fuzzy: a near-match is a judgement call,
 *  and refusing to file a genuinely new epic is worse than filing a near-duplicate the user can see
 *  and close. */
function sameTitle(a: string, b: string): boolean {
  const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

/**
 * An OPEN, typed epic already carrying this exact title, or null.
 *
 * FAILS OPEN, and that is the important half: a dedupe read that errors is not evidence of a
 * duplicate, so it must never block a create. The cost of getting this wrong in the other direction
 * is the user asking for an epic and being told one already exists when it does not.
 *
 * Scoped to `issueType: "epic"` rather than to this module's broader `isEpic` (typed epic OR has
 * children) on purpose: this is asking "did create_plan already file this", and create_plan only
 * ever writes typed epics. Widening it would let an ordinary task with a matching title suppress a
 * real epic.
 */
async function alreadyFiledId(projectPath: string, title: string): Promise<string | null> {
  // BOUNDED, because this read is the FIRST of three bd invocations inside one bridge call and the
  // bridge kills the call at 50s. On the full BD_TIMEOUT the chain is 30 + 30 + 10 = 70s, so a slow
  // dedupe read alone reintroduces the failure the confirmation probe exists to remove — and it
  // does not need every stage maxed: any dedupe slower than ~10s already pushes create + probe past
  // the ceiling. See CREATE_PLAN_DEDUPE_BUDGET_MS for why abandoning THIS one specifically is safe.
  const page = await withDeadline(
    beadsQuery(projectPath, {
      issueType: "epic",
      titleContains: title.trim(),
      includeClosed: false,
      limit: 50,
    }),
    CREATE_PLAN_DEDUPE_BUDGET_MS,
  );
  // `withDeadline` never rejects: an expiry and an error both arrive as null, and both mean the
  // same thing here — we could not find out, so proceed and file. A dedupe read that failed is not
  // evidence of a duplicate.
  if (!page) return null;
  return page.beads.find((b) => sameTitle(b.title, title))?.id ?? null;
}

/**
 * File a new plan. Children are added with the board domain's `create_item`.
 *
 * MUST carry an explicit `"epic"` type. A create with no type takes bd's default — `task` — and the
 * result then fails `isEpic` EVERYWHERE in this module: invisible to `list_plans`, and refused as
 * `not-a-plan` by both `get_plan` and `promote_plan_to_build`. The create → inspect → promote
 * workflow this domain exists to deliver would dead-end at its first step (roborev 55131).
 *
 * GOES THROUGH `beadsCreate`, NOT `createBeadFull`, AND THAT IS THE POINT OF THIS FUNCTION.
 * `createBeadFull` reaches `notes.rs::create_bead_full` → `run_bd` → a hard 30s bound with NO
 * read-back, so a create that bd acknowledged but the store dropped is reported as success, and a
 * create that timed out is reported as failure — with no way to tell either from the truth.
 * `beadsCreate` runs the create, then PROBES the store for the row before reporting anything (see
 * `beads_cmd.rs::create_bead`), and it deliberately does not retry, because re-running a create
 * whose first write actually landed is how one epic becomes two.
 */
export async function createPlan(
  projectPath: string,
  projectId: string,
  title: string,
  body: string,
): Promise<PlansResult<CreatedPlan>> {
  // BEFORE the write, not after. The founder's own use is to reel off several efforts he has been
  // asking about for weeks, so "have I already filed this one" is the common case rather than an
  // edge one — and once a duplicate exists, nothing in the app removes it.
  // ONE WALL-CLOCK DEADLINE OVER THE WHOLE CHAIN, measured on the clock the bridge is watching.
  // Two review rounds caught a guard that summed the Rust budgets and still under-counted — first
  // missing the dedupe read, then missing `READER_DRAIN_GRACE`, which adds up to 2x5s to every
  // COMPLETED bd invocation. Modelling another process's internals is wrong by default; a deadline
  // here is complete by construction. See CREATE_PLAN_TOTAL_BUDGET_MS.
  const startedAt = Date.now();
  const existing = await alreadyFiledId(projectPath, title);
  if (existing) {
    return ok("create_plan", { id: existing, title, outcome: "already-filed" });
  }
  const remaining = CREATE_PLAN_TOTAL_BUDGET_MS - (Date.now() - startedAt);
  try {
    const created = await withDeadlineOrExpired(
      beadsCreate(projectPath, { title, description: body, issueType: "epic" }),
      Math.max(remaining, 0),
    );
    if (created === DEADLINE_EXPIRED) {
      // NOT a failure claim. We stopped waiting; bd may well be finishing the write right now — so
      // this is the honest `unknown`, and it is the SAME fact a bridge kill would have delivered,
      // except it arrives as a refusal the model can act on instead of an opaque transport error.
      return refuse(
        "create_plan",
        "outcome-unknown",
        `The work graph didn't answer within ${Math.round(CREATE_PLAN_TOTAL_BUDGET_MS / 1000)}s, so I ` +
          "stopped waiting before the tool call itself would have been cut off. The epic may or may " +
          "not have been filed. Check `list_plans` for it before creating another one; filing a " +
          "second is worse than waiting, because nothing removes a duplicate epic.",
      );
    }
    // FIRE-AND-FORGET (bead `sparkle-wab4lm`). The epic now exists and is confirmed; filling its
    // GOAL is a paid AI call of several seconds, and the founder's constraint is explicit — do not
    // put a call of that latency synchronously on the epic-creation path; generate async and fill
    // the field when it lands. So: `void`, never awaited, and its own `.catch` so nothing it does
    // can reject into this function and turn a successful create into a refusal. `requestEpicGoal`
    // gates itself on the human latch and the master AI gate, so this line spends nothing when
    // either says no.
    //
    // `projectId` is a PARAMETER, not reverse-derived from the path (roborev 65858). The first cut
    // looked the project up by `p.rootPath === projectPath` and skipped generation silently on a
    // miss — no goal, no failure record, no diagnostic, which is the silent-inert shape. It was
    // also an exact-string compare, the idiom `conciergeTools/workspace.ts` documents as retired
    // for being strictly weaker than the repo's normalizer (case-folding, NFC, linked worktrees).
    // The route already holds the id (`withProject(ctx, a.projectId, (p) => …)`), and this module's
    // own siblings `listPlans`/`getPlan` already take it, so there was nothing to derive.
    void requestEpicGoal(epicGoalGenDeps, {
      projectId,
      projectPath,
      epicId: created.id,
    }).catch((e) => log.error("plans", `epic-goal generation crashed for ${created.id}`, e));
    return ok("create_plan", { id: created.id, title, outcome: "created" });
  } catch (e) {
    return refuseCreate(e);
  }
}

/** Turn a create failure into a refusal that says WHICH of the three things happened — see
 *  {@link createFailureVerdict}. Split out so the message wording is testable on its own. */
function refuseCreate(e: unknown): PlansRefusal {
  const err: BeadsError = toBeadsError(e);
  switch (createFailureVerdict(e)) {
    case "unavailable":
      return refuse(
        "create_plan",
        "beads-unavailable",
        "This project doesn't have a beads database (or `bd` isn't installed), so it has no plans. " +
          "Run `bd init` in the project to start one.",
      );
    case "not-created":
      return refuse(
        "create_plan",
        "not-created",
        `Nothing was filed — ${err.message}. No epic exists, so it is safe to try again as-is.`,
      );
    default:
      return refuse(
        "create_plan",
        "outcome-unknown",
        `I couldn't confirm what happened — ${err.message}. The epic may or may not have been ` +
          "filed. Check `list_plans` for it before creating another one; filing a second is worse " +
          "than waiting, because nothing removes a duplicate epic.",
      );
  }
}

/**
 * Hand a plan to a build agent, carrying the plan's content into the agent's brief.
 *
 * That last part is the point of the section: promoting must not produce a blank agent the human
 * then has to brief. `sendToBuild` builds the seed prompt from the epic + its PRD and delivers it,
 * and it is also where ONE ORCHESTRATOR PER EPIC is enforced — so this delegates rather than
 * spawning directly. A plan already bound to an orchestrator therefore RESUMES that agent instead
 * of starting a rival one, which is why the reply reports whether the agent was reused.
 */
export async function promotePlanToBuild(
  projectPath: string,
  projectId: string,
  epicId: string,
  prdPath: string | null,
): Promise<PlansResult<{ agentId: string; epicId: string; reused: boolean }>> {
  // The bead AND the full list: epic-ness is a property of the SET (does anything point at this
  // bead?), so a lone `beadShow` cannot answer it. Fetched together — a de-facto epic typed
  // `feature` would otherwise be refused as `not-a-plan` here even though `list_plans` offered it,
  // which is the same split-brain this change exists to remove.
  const found = await attempt("promote_plan_to_build", async () => {
    const [epic, beads] = await Promise.all([beadShow(projectPath, epicId), listBeads(projectPath)]);
    return { epic, beads };
  });
  if (!found.ok) return found;
  if (!found.data.epic) {
    return refuse(
      "promote_plan_to_build",
      "unknown-plan",
      `I couldn't find a plan with id ${epicId} in this project.`,
    );
  }
  if (!isEpic(found.data.beads, found.data.epic)) {
    return refuse(
      "promote_plan_to_build",
      "not-a-plan",
      `${epicId} is a ${found.data.epic.type ?? "task"}, not a plan. Promoting builds an epic's children ` +
        `across workers; for a single task, start a build agent and brief it with the task instead.`,
    );
  }
  // Read BEFORE the handoff: sendToBuild reuses an agent already bound to this epic, so asking
  // afterwards could not distinguish "reused" from "just created".
  const already = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)
    ?.agents.some((a) => a.kind === "build" && a.epicId === epicId);
  // The machine-wide cap is enforced INSIDE `sendToBuild` (roborev 55135), not here. Gating the
  // caller left the four Plan-board handoffs ungated — the same "a cap enforced on some paths is
  // not a cap" failure this was meant to close. What is left here is TRANSLATION: turn its typed
  // throw into this domain's own refusal vocabulary, so the concierge gets `at-capacity` rather than
  // a generic `action-failed` it cannot reason about.
  try {
    // `humanAuthored: false` — this is the concierge's TOOL layer, not a board click (roborev
    // 55721). It matters on the reuse path `already` is read for two lines up: seeding a REUSED
    // orchestrator through `appendPrompt` releases its goal debt, so an LLM promoting an epic whose
    // orchestrator is escalated would un-latch the escalation.
    //
    // STILL TRUE NOW THAT THE CONCIERGE *CAN* CLEAR ONE, and the reason is the route rather than the
    // actor. Its re-arm lever (agentGoal's `rearmGoal`, bounded by MAX_CONCIERGE_REARMS and refilled
    // only by a human typing to the agent) is an explicit, counted, reasoned call —
    // `set_agent_escalation`. An un-latch falling out of a PROMOTION is none of those: nothing is
    // spent, nothing is attributable, and the bound that makes the lever safe is bypassed entirely.
    // So this flag is not "the concierge may never re-arm"; it is "a re-arm is never a side effect".
    // `attention: "auto"` for the same reason as `humanAuthored: false` just above — this is the
    // LLM promoting a plan, not a hand on the board's Start button. So if the founder's caret is in
    // a terminal when it lands, the orchestrator is still bound, seeded and relaunched; it just
    // does not take his screen (engine/attentionGuard). Every board click keeps the default.
    const agentId = sendToBuild({
      projectId,
      epicId,
      prdPath,
      mode: "epic",
      humanAuthored: false,
      attention: "auto",
    });
    return ok("promote_plan_to_build", { agentId, epicId, reused: Boolean(already) });
  } catch (e) {
    if (e instanceof AtCapacityError) {
      return refuse("promote_plan_to_build", "at-capacity", e.message);
    }
    return refuse(
      "promote_plan_to_build",
      "action-failed",
      e instanceof Error ? e.message : String(e),
    );
  }
}
