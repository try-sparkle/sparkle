// The RESEARCH domain — "Concierge Agents" (bead `sparkle-s7rfc`). The concierge's ability to send a
// question off to a background `claude` child and CARRY ON TALKING while it runs.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE PROPERTY THIS MODULE EXISTS TO HOLD: `dispatch` RETURNS BEFORE THE WORK IS DONE.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Everything else here is bookkeeping around that. The concierge brain is ONE `claude -p` process
// per turn, so a tool call that waits for its answer does not "take a while" — it holds the whole
// turn, the human's next sentence, and the bridge's round trip hostage on a research child that may
// run for minutes. That is precisely the blocking this feature replaces, and it is invisible at the
// call site: an implementation that awaited the child would have the identical signature, the
// identical return type, and a green test suite.
//
// So the property is enforced structurally rather than hoped for:
//
//   • This module NEVER reads a task back to see whether it finished. There is no poll, no
//     "wait until terminal", no retry loop. `dispatch` performs exactly ONE round trip — the one
//     that mints the task — and reports whatever non-terminal state that round trip returned.
//   • That round trip is itself BOUNDED (`DISPATCH_ACK_MS`), so even a wedged runner cannot make
//     this call outlast the bridge's own 30s default and turn a started task into an unattributed
//     `bridge request timeout`. See `dispatchResearchTask` for what the bound reports instead.
//   • `research.test.ts` drives both halves: a never-resolving `getResearch` (the reply must still
//     settle with the task record) and a never-resolving `dispatchResearch` on a manual clock (the
//     call must still settle, as a bounded refusal). Both were confirmed to go RED against a
//     hand-mutated version of this file that awaits the child.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY `dispatch` IS `routine` AND NOT `costs-money`
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A research child is a metered model call, so `costs-money` is defensible on the letter — and it
// would derive to `ask`, which is the founder's explicit NO: "no cap, trust the concierge". The
// reasoning is that an approval prompt per question defeats the feature outright. The whole point is
// that the concierge can go and find something out without turning it into an interruption; a
// dispatch the human has to authorise is just a slower version of asking them to go look it up.
// Anyone who disagrees sets `concierge.tools.dispatch` to "Ask first" in Settings → Concierge tools,
// which is exactly what the per-tool policy is for.
//
// `cancel` is `routine` for a narrower reason, and it is deliberately NOT the `disruptive` that
// `close_agent`/`stop_agent` earn in policy.ts's RISK_OVERRIDES. Those stop an AGENT — a session the
// human is working with, whose running state cannot be put back. This stops a background question
// the concierge asked on its own initiative; the cost of stopping it is one re-dispatch, and the
// cost of NOT being able to stop it is a metered child nobody can call off without a human
// approving the cancellation of work they never approved starting.
import {
  cancelResearch,
  dispatchResearch,
  getResearch,
  listResearch,
  liveTasks,
  sortedTasks,
  useResearchStore,
  type DispatchResearchInput,
} from "../research/store";
import { isLive, isTerminal, type ResearchDepth, type ResearchTask } from "../research/types";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const RESEARCH_OPS = ["dispatch", "list", "get", "cancel"] as const;

export type ResearchOp = (typeof RESEARCH_OPS)[number];

/** Two words, matching the vocabulary `workspace` publishes, so policy.ts reuses that translation
 *  rather than declaring a table identical to it. See the header for why `dispatch` and `cancel`
 *  are `routine` — both derive to `allow`, which is the founder's stated choice, not a default
 *  nobody looked at. */
export type ResearchRisk = "read-only" | "routine";

export const RESEARCH_RISK: Record<ResearchOp, ResearchRisk> = {
  dispatch: "routine",
  list: "read-only",
  get: "read-only",
  cancel: "routine",
};

// ---------------------------------------------------------------------------------------------
// Results — the board/approvals convention
// ---------------------------------------------------------------------------------------------

export interface ResearchOk<T> {
  ok: true;
  op: ResearchOp;
  risk: ResearchRisk;
  data: T;
}

export interface ResearchRefusal {
  ok: false;
  op: ResearchOp;
  risk: ResearchRisk;
  reason: string;
  message: string;
}

export type ResearchResult<T> = ResearchOk<T> | ResearchRefusal;

function ok<T>(op: ResearchOp, data: T): ResearchOk<T> {
  return { ok: true, op, risk: RESEARCH_RISK[op], data };
}

function refuse(op: ResearchOp, reason: string, message: string): ResearchRefusal {
  return { ok: false, op, risk: RESEARCH_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

/**
 * One task as the concierge sees it.
 *
 * `taskId` rather than `id` because that is the name the ops take as an ARGUMENT — a reply whose
 * identifier is spelled differently from the parameter that consumes it is one rename away from a
 * model passing the wrong field.
 *
 * `findings` and `error` are carried on every view rather than only on `get`. They are `null` for a
 * live task by the contract in research/types.ts, and a field that is present-and-null says "not
 * yet" where an absent field says "this shape does not have findings" — the distinction the whole
 * `T | null` rule in that file exists to preserve.
 */
export interface ResearchTaskView {
  taskId: string;
  question: string;
  depth: ResearchDepth;
  projectId: string | null;
  status: ResearchTask["status"];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Still occupying a process or waiting for one. Derived from `isLive` so the row, the drain and
   *  this domain cannot disagree about what "running" means. */
  live: boolean;
  findings: string | null;
  error: string | null;
}

function viewOf(t: ResearchTask): ResearchTaskView {
  return {
    taskId: t.id,
    question: t.question,
    depth: t.depth,
    projectId: t.projectId,
    status: t.status,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    live: isLive(t),
    findings: t.findings,
    error: t.error,
  };
}

/** What `list` answers with. Split rather than one array because the two questions the concierge
 *  actually asks are "what am I still waiting on" and "what came back" — and a single sorted list
 *  makes a model derive that split itself, differently each time. */
export interface ResearchListView {
  running: ResearchTaskView[];
  recent: ResearchTaskView[];
  /** How many finished tasks exist in total. `recent` is CAPPED, and a cap that is not reported
   *  reads as "that is all of them" — the truncation trap AGENTS.md names. */
  totalFinished: number;
}

/** The cap on `recent`. Small on purpose: the row is the surface for browsing history, and a tool
 *  reply that dumps fifty findings into a turn's context is spending the concierge's budget on
 *  answers nobody asked for a second time. */
export const MAX_RECENT_RESEARCH = 10;

// ---------------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------------

/**
 * Everything this module reaches outside itself, as ONE injectable object.
 *
 * The clock and the timer are here for the same reason the four commands are: `dispatch`'s bound is
 * the mechanism the non-blocking property is enforced by, and a bound that can only be exercised by
 * waiting ten real seconds is a bound no test will ever cover. AGENTS.md's warning about a defaulted
 * seam applies and is answered: `research.test.ts` drives the ops through `dispatchConciergeTool`
 * with the STORE MODULE mocked and no deps passed at all, so the production call site — the one that
 * supplies `LIVE_RESEARCH_DEPS` — is itself under test rather than replaced by every case.
 */
export interface ResearchDeps {
  dispatch: (input: DispatchResearchInput) => Promise<ResearchTask>;
  list: () => Promise<ResearchTask[]>;
  get: (taskId: string) => Promise<ResearchTask | null>;
  cancel: (taskId: string) => Promise<ResearchTask>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  /** Fold a task we just learned about into the window's cache, so the sidebar row reflects a
   *  dispatch immediately rather than at its next poll. A CACHE write — the disk is the truth
   *  (see research/store.ts), so nothing here depends on it having happened. */
  remember: (task: ResearchTask) => void;
}

export const LIVE_RESEARCH_DEPS: ResearchDeps = {
  dispatch: dispatchResearch,
  list: listResearch,
  get: getResearch,
  cancel: cancelResearch,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (handle) => clearTimeout(handle),
  remember: (task) => useResearchStore.getState().upsert(task),
};

/**
 * How long `dispatch` waits for the runner to say the task EXISTS before answering anyway.
 *
 * Not a bound on the research — the research is unbounded by design and is not being waited for.
 * This bounds the one round trip that mints the task, which writes a JSON file and spawns a child
 * and is sub-second in practice.
 *
 * 10s, and the ceiling is what makes the number matter rather than the floor: the MCP layer gives
 * `concierge_tool` a 30s default (`DEFAULT_BRIDGE_TIMEOUT_MS`, apps/mcp-control), and
 * `research:dispatch` is deliberately NOT in `SLOW_CONCIERGE_OPS` — it is the one op in the spine
 * whose contract is that it returns before its work is done, so granting it the raised 50s ceiling
 * would be a silent regression. Answering at 10s keeps the refusal ATTRIBUTABLE: the concierge is
 * told "the runner did not acknowledge" and what to do about it, instead of receiving the generic
 * `bridge request timeout: concierge_tool` that every one of the ~55 tools fails with.
 */
export const DISPATCH_ACK_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------------------------

/** What the caller asked to research. `projectId` is RESOLVED BY THE REGISTRY from the store — a
 *  model never names a repo root, and `null` is a supported state, not a failure (see types.ts). */
export interface ResearchDispatchInput {
  question: string;
  projectId: string | null;
  /** Absolute path the child runs in — resolved from the store by the registry, never by a model.
   *  The runner REFUSES a missing root rather than guessing a directory; see store.ts. */
  projectRoot: string;
  depth: ResearchDepth;
}

type Acked =
  | { kind: "acked"; task: ResearchTask }
  | { kind: "failed"; error: string }
  | { kind: "unacked" };

/**
 * Start a research task and answer immediately with the task as it exists RIGHT NOW.
 *
 * The returned status is `queued` or `running`; it is never `done`, and nothing here waits for it to
 * become `done`. That is the feature, not an implementation detail — read the file header.
 *
 * THREE OUTCOMES, and the third is the interesting one:
 *
 *   • the runner acknowledged → the task record, live and unfinished.
 *   • the runner refused/threw → a `dispatch-failed` refusal carrying its message.
 *   • the runner said nothing within `DISPATCH_ACK_MS` → a `not-acknowledged` refusal that
 *     explicitly does NOT tell the caller to try again. Nothing cancels the in-flight command, so
 *     the task was very probably created and only the acknowledgement was lost; a reflexive retry
 *     starts a SECOND metered child for one question. The remedy named is `list`, which is a read.
 *     (Same reasoning, and the same failure shape, as `retryAdviceFor` in apps/mcp-control/tools.ts.)
 */
export async function dispatchResearchTask(
  input: ResearchDispatchInput,
  deps: ResearchDeps = LIVE_RESEARCH_DEPS,
): Promise<ResearchResult<ResearchTaskView>> {
  const question = input.question.trim();
  if (!question) {
    return refuse(
      "dispatch",
      "empty-question",
      "I can't dispatch research with no question — tell me what to find out.",
    );
  }

  let handle: number | null = null;
  const bound = new Promise<Acked>((resolve) => {
    handle = deps.setTimer(() => resolve({ kind: "unacked" }), DISPATCH_ACK_MS);
  });

  let outcome: Acked;
  try {
    // ONE round trip, raced against the bound. `.then(ok, err)` rather than a try/catch around the
    // race, so a rejection resolves the race arm instead of escaping past the timer we must clear.
    outcome = await Promise.race([
      deps
        .dispatch({
        question,
        projectId: input.projectId,
        projectRoot: input.projectRoot,
        depth: input.depth,
      })
        .then<Acked, Acked>(
          (task) => ({ kind: "acked", task }),
          (e: unknown) => ({ kind: "failed", error: e instanceof Error ? e.message : String(e) }),
        ),
      bound,
    ]);
  } finally {
    if (handle !== null) deps.clearTimer(handle);
  }

  if (outcome.kind === "failed") {
    return refuse(
      "dispatch",
      "dispatch-failed",
      `I couldn't start that research task: ${outcome.error}`,
    );
  }
  if (outcome.kind === "unacked") {
    return refuse(
      "dispatch",
      "not-acknowledged",
      `I asked for that research but the runner hasn't confirmed it started within ` +
        `${Math.round(DISPATCH_ACK_MS / 1000)} seconds. It has most likely started anyway — nothing ` +
        `cancels a command already in flight — so DO NOT ask me to dispatch it again, which would ` +
        `start a second one. Use list to see whether it is there.`,
    );
  }

  deps.remember(outcome.task);
  return ok("dispatch", viewOf(outcome.task));
}

/** Running tasks and the most recent finished ones. One read; nothing is waited on. */
export async function listResearchTasks(
  deps: ResearchDeps = LIVE_RESEARCH_DEPS,
): Promise<ResearchResult<ResearchListView>> {
  let tasks: ResearchTask[];
  try {
    tasks = await deps.list();
  } catch (e) {
    return refuse(
      "list",
      "list-failed",
      `I couldn't read the research tasks: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const finished = sortedTasks(tasks.filter((t) => isTerminal(t.status)));
  return ok("list", {
    running: liveTasks(tasks).map(viewOf),
    recent: finished.slice(0, MAX_RECENT_RESEARCH).map(viewOf),
    totalFinished: finished.length,
  });
}

/**
 * One task by id, INCLUDING its findings once it has them.
 *
 * A missing id is its own refusal rather than an empty success, for the reason `getApproval` gives:
 * "I can't find it" and "it hasn't finished" must not read the same to a model deciding whether to
 * keep waiting.
 */
export async function getResearchTask(
  taskId: string,
  deps: ResearchDeps = LIVE_RESEARCH_DEPS,
): Promise<ResearchResult<ResearchTaskView>> {
  let task: ResearchTask | null;
  try {
    task = await deps.get(taskId);
  } catch (e) {
    return refuse(
      "get",
      "get-failed",
      `I couldn't read research task ${taskId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!task) {
    return refuse(
      "get",
      "unknown-task",
      `I don't have a research task with id ${taskId}. Use list to see the ones I do have.`,
    );
  }
  deps.remember(task);
  return ok("get", viewOf(task));
}

/**
 * Stop a task. Returns THE TASK, not a bare acknowledgement.
 *
 * Returning the record is what lets the caller tell "I stopped it" from "there was nothing left to
 * stop": a task that had already reached `done` between the human asking and this call landing comes
 * back with `status: "done"` and its findings, so a model cannot report that it called off work
 * which had in fact already answered the question. The runner owns that decision — this layer does
 * not second-guess the status it is handed, and a runner-side refusal arrives as `cancel-failed`
 * carrying the runner's own sentence.
 */
export async function cancelResearchTask(
  taskId: string,
  deps: ResearchDeps = LIVE_RESEARCH_DEPS,
): Promise<ResearchResult<ResearchTaskView>> {
  let task: ResearchTask;
  try {
    task = await deps.cancel(taskId);
  } catch (e) {
    return refuse(
      "cancel",
      "cancel-failed",
      `I couldn't cancel research task ${taskId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  deps.remember(task);
  return ok("cancel", viewOf(task));
}
