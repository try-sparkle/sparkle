// THE RESEARCH STORE AND THE COMMAND SURFACE — the second half of the contract in `./types.ts`.
//
// This file exists at the same moment as the types for the same reason: the Rust runner, the sidebar
// row and the turn-start drain are built in parallel, and all three need to agree on the names of
// the five Tauri commands and on the shape of the client-side cache. Names invented independently by
// three units do not converge.
//
// ══ THE STORE IS A CACHE. THE DISK IS THE TRUTH. ════════════════════════════════════════════════
//
// `<app_data>/research/<id>.json` is the source of truth, and this is a live mirror of it — the same
// posture `approvalsStore` takes toward `config.toml`. That ordering is not stylistic. The concierge
// that dispatched a task at 12:01 has EXITED by 12:03, and a window that was never open cannot have
// cached anything; a result must survive both. So nothing here is persisted, nothing here is
// authoritative, and every read path tolerates an empty store by refetching rather than by
// concluding there is no work.
//
// ══ PURE SELECTORS, EXPORTED SEPARATELY ════════════════════════════════════════════════════════
//
// `liveTasks` / `unreadTasks` / `sortedTasks` take an array and return an array. They are the
// functions the sidebar row and the drain actually depend on, and keeping them out of the hook means
// both can be unit-tested with no DOM, no Tauri and no store — which is what lets the drain's
// exactly-once behaviour be tested as arithmetic instead of by mounting an app.
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";

import { log } from "../../logger";
import { isLive, isRetired, isUnread, type ResearchDepth, type ResearchTask } from "./types";

// ---------------------------------------------------------------------------------------------
// The Tauri command surface — these five strings are the contract with `src-tauri/src/research.rs`
// ---------------------------------------------------------------------------------------------

/**
 * Named as a const rather than inlined at each call so the Rust side has ONE list to satisfy and a
 * drift test has one thing to read. A typo in an `invoke` string is a runtime failure with no
 * compile-time signal, which is exactly the class of bug a shared constant removes.
 */
export const RESEARCH_COMMANDS = {
  dispatch: "research_dispatch",
  list: "research_list",
  get: "research_get",
  cancel: "research_cancel",
  markRead: "research_mark_read",
} as const;

/**
 * How often a window re-lists the research tasks from disk.
 *
 * WITHOUT A POLL THE FEATURE IS INERT (roborev 61698). Nothing else re-lists while a window stays
 * open, so a task that completes mid-session is never observed: it stays `running` in the cache,
 * `isUnread` stays false, the preamble stays empty, and the finding the founder asked for is never
 * reported. That is the entire feature failing silently.
 *
 * Five seconds is deliberately far finer than what it watches (research completes on a wall clock of
 * minutes) and each tick is one directory read, so the cadence is cheap relative to being wrong.
 */
export const RESEARCH_POLL_INTERVAL_MS = 5_000;

export interface DispatchResearchInput {
  question: string;
  /** `null` when no project could be resolved — a real state the runner accepts. See types.ts. */
  projectId: string | null;
  /**
   * The ABSOLUTE path the child runs in. REQUIRED, and resolved app-side from `projectId` — never
   * supplied by a model, which is the same rule every other store-resolved argument follows.
   *
   * This field was missing at first and the omission was invisible: the Rust side defaulted a
   * missing root to the process cwd, which for a packaged app is not a repo, so every dispatch would
   * have researched the wrong tree and answered confidently about it. The runner now refuses a
   * missing root outright — a guessed directory cannot be told apart from a correct one downstream.
   */
  projectRoot: string;
  depth: ResearchDepth;
}

/**
 * Start a research task. RETURNS AS SOON AS THE TASK EXISTS, not when it finishes.
 *
 * This is the whole feature in one line, and it is the property the goal is written against: the
 * returned task is `queued` or `running`, never `done`. A version of this that awaited the child
 * would be indistinguishable at the call site and would reintroduce exactly the blocking this
 * replaces — so `research.rs` has a test asserting the child is still live when dispatch returns,
 * and the registry has its own.
 */
export async function dispatchResearch(input: DispatchResearchInput): Promise<ResearchTask> {
  return invoke<ResearchTask>(RESEARCH_COMMANDS.dispatch, {
    question: input.question,
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    depth: input.depth,
  });
}

export async function listResearch(): Promise<ResearchTask[]> {
  return invoke<ResearchTask[]>(RESEARCH_COMMANDS.list, {});
}

/** `null` for an id that does not exist — distinguishable from a task that exists and has no
 *  findings, which is why this is not an empty-object success. */
export async function getResearch(taskId: string): Promise<ResearchTask | null> {
  return invoke<ResearchTask | null>(RESEARCH_COMMANDS.get, { taskId });
}

export async function cancelResearch(taskId: string): Promise<ResearchTask> {
  return invoke<ResearchTask>(RESEARCH_COMMANDS.cancel, { taskId });
}

/**
 * THE CLAIM. Stamp `readAt` on tasks whose findings have been delivered to a concierge turn.
 *
 * CALL THIS ONLY AFTER `invoke("concierge_turn")` RESOLVES. Peek must never claim: a turn that dies
 * mid-flight has told the founder nothing, and a finding claimed at preamble-build time would be
 * gone forever. Claiming after the resolve makes the worst case a REPEAT (the finding is told twice)
 * rather than a LOSS, and repeating is recoverable where losing is not.
 */
export async function markResearchRead(taskIds: string[], at: number): Promise<void> {
  if (taskIds.length === 0) return;
  await invoke<void>(RESEARCH_COMMANDS.markRead, { taskIds, at });
}

// ---------------------------------------------------------------------------------------------
// Pure selectors — no store, no DOM, no Tauri
// ---------------------------------------------------------------------------------------------

/** Newest first. The row and the detail list both want this order; deriving it twice is how two
 *  surfaces come to disagree about which task is "the latest". */
export function sortedTasks(tasks: readonly ResearchTask[]): ResearchTask[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

/** What the "Concierge Agents" row counts in its `+[n]`. */
export function liveTasks(tasks: readonly ResearchTask[]): ResearchTask[] {
  return sortedTasks(tasks.filter(isLive));
}

/**
 * What the "Concierge Agents" row actually RENDERS — everything except the retired.
 *
 * The row used to render `sortedTasks(Object.values(byId))`: every task the store had ever seen,
 * for the life of the install. There was no retirement concept anywhere and no pruning on either
 * side of the seam, so the founder's sidebar reached 28 stacked rows — 11 of them red at exactly
 * 3m, all of them dead research runs that had already said everything they were going to say.
 *
 * A row disappears when {@link isRetired} says the concierge has been told. Live work is never
 * retired, so anything genuinely in flight still shows; and a finished task whose findings are still
 * owed is not retired either, because that predicate and `isUnread` read the same `readAt`. The row
 * therefore cannot outrun the drain — it is not a rule this function enforces, it is one it cannot
 * express the violation of.
 *
 * NOTHING IS DELETED. `retired` means "not in the sidebar": the task's JSON stays on disk with its
 * findings intact and its record readable. Teardown is a surface decision, not a data one.
 */
export function visibleTasks(tasks: readonly ResearchTask[]): ResearchTask[] {
  return sortedTasks(tasks.filter((t) => !isRetired(t)));
}

/**
 * What the turn-start drain folds into the prompt preamble — OLDEST FIRST.
 *
 * Deliberately the opposite order from `sortedTasks`. The preamble is read as a narrative by a model
 * that then answers the founder; delivering "here is what came back" newest-first tells the story
 * backwards. Everything the human LOOKS at is newest-first; the one thing a model READS is
 * chronological.
 */
export function unreadTasks(tasks: readonly ResearchTask[]): ResearchTask[] {
  return tasks.filter(isUnread).sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

interface ResearchState {
  /** taskId → task. A map rather than an array so an out-of-order status update from the runner
   *  cannot duplicate a row. */
  byId: Record<string, ResearchTask>;
  /** True once the first `listResearch()` has landed. Lets the row tell "no tasks" apart from
   *  "we have not looked yet" — the row renders `+0` for the first and nothing for the second. */
  hydrated: boolean;
  /** Which task the founder has expanded in the detail view; `null` when none. */
  openTaskId: string | null;

  upsert: (task: ResearchTask) => void;
  replaceAll: (tasks: ResearchTask[]) => void;
  setOpenTask: (taskId: string | null) => void;
}

export const useResearchStore = create<ResearchState>((set) => ({
  byId: {},
  hydrated: false,
  openTaskId: null,

  upsert: (task) => set((s) => ({ byId: { ...s.byId, [task.id]: task } })),

  // REPLACE, not merge. The disk is the truth, so a task that is gone from a full listing is gone —
  // merging would resurrect a task the runner had reaped and leave it in the row forever.
  replaceAll: (tasks) =>
    set(() => ({
      byId: Object.fromEntries(tasks.map((t) => [t.id, t])),
      hydrated: true,
    })),

  setOpenTask: (taskId) => set(() => ({ openTaskId: taskId })),
}));

/**
 * Every task this window knows about, read IMPERATIVELY — it does not subscribe.
 *
 * ══ NAMED `…Now` SO A COMPONENT CANNOT REACH FOR IT BY ACCIDENT ═════════════════════════════════
 *
 * This was `allTasks()`, and the name was a trap (roborev 61562). It was the only exported way to
 * get the array, while the pure selectors above advertise themselves as what the row depends on and
 * take an array — so the natural thing to write in a component is `liveTasks(allTasks())`, which
 * reads the store ONCE at mount and never subscribes. The row would render its `+[n]` before
 * hydration, `refreshResearch()` would land three tasks, and nothing would schedule a re-render:
 * the count sits at zero until some unrelated parent happens to re-render.
 *
 * Use {@link useResearchTasks} in anything that renders. This one is for the drain and other
 * non-React callers, where subscribing would be meaningless.
 */
export function allTasksNow(): ResearchTask[] {
  return Object.values(useResearchStore.getState().byId);
}

/**
 * THE REACTIVE READ — what every component must use.
 *
 * Compose it with the pure selectors (`liveTasks(useResearchTasks())`) and the row re-renders when
 * a task's status moves, which is the entire point of a `+[n]` that counts running work.
 */
export function useResearchTasks(): ResearchTask[] {
  return useResearchStore(useShallow((s) => Object.values(s.byId)));
}

/**
 * Monotonic request id, so a STALE response can be dropped instead of overwriting a fresher one.
 *
 * `replaceAll` is deliberately destructive, and that is exactly what turns an out-of-order response
 * from "briefly stale" into "the row loses a task" (roborev 61562): a poll issues `listResearch()`,
 * the founder dispatches, a second refresh is issued and RESOLVES FIRST with the new task, then the
 * older in-flight response lands and replaces the list with the pre-dispatch one. The task the
 * founder just asked for disappears from the row and `+[n]` drops, until the next poll happens to
 * put it back. Concurrent invocation is not hypothetical here — this function's own contract invites
 * it ("on mount, after a dispatch, and on a poll").
 */
let refreshSeq = 0;

/**
 * Refresh the cache from disk. Safe to call on mount, after a dispatch, and on a poll.
 *
 * Failures are logged and swallowed: this is a cache refresh, and a window that cannot reach the
 * backend must not turn a working feature into a crashing one. The row simply keeps showing what it
 * last knew, which is the honest thing for a mirror to do.
 *
 * A FAILED FIRST LOAD STILL HYDRATES. Otherwise the row's "no tasks" vs "we have not looked yet"
 * distinction latches permanently at the second one, and the row stays blank forever rather than
 * showing the `+0` that is actually true of what this window knows.
 */
export async function refreshResearch(): Promise<void> {
  const seq = ++refreshSeq;
  try {
    const tasks = await listResearch();
    // Drop a response that a newer refresh has already superseded.
    if (seq !== refreshSeq) return;
    useResearchStore.getState().replaceAll(tasks);
  } catch (e) {
    log.warn("research", "could not refresh research tasks", { error: String(e) });
    if (seq === refreshSeq && !useResearchStore.getState().hydrated) {
      useResearchStore.setState({ hydrated: true });
    }
  }
}

/** Test seam: forget everything, including the in-flight refresh generation. */
export function _resetResearchStoreForTests(): void {
  refreshSeq = 0;
  useResearchStore.setState({ byId: {}, hydrated: false, openTaskId: null });
}
