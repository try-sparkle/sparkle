// WATCHING A DISPATCHED PASS FOR ITS ANSWER — the half that turns `advisor:skipped (not yet)` into
// `advisor:reviewed`.
//
// The pass is DISPATCHED and never awaited (`research.rs` returns before its child finishes), so
// something has to notice when the child answers. This is that something, and it is deliberately
// SELF-CONTAINED: it tracks only the tasks the advisor itself dispatched and polls them by id,
// rather than hooking `services/research/store`'s poll. Two reasons, and the second is the real one:
//
//   • the research store is a shared file three other units already build against, and a hook there
//     would put this feature in the merge path of every one of them;
//   • the advisor needs to remember the (epicId, model) a task belongs to, which the store's task
//     record does not carry — so it would need its own map regardless, and a map plus a hook is
//     strictly more moving parts than a map plus a timer.
//
// PURE-CORE + THIN SHELL, like the rest of this directory: `pollAdvisorTasks` takes its clock, its
// task reader and its settle function as arguments, so the whole state machine is unit-testable with
// no timers and no Tauri.
import { log } from "../../logger";
import type { ResearchTask } from "../research/types";
import { phaseOf } from "../research/types";
import { getResearch } from "../research/store";
import { settleAdvisorPass, type AdvisorPassDeps } from "./pass";
import { productionDeps } from "./deps";

/** One dispatched pass, waiting for its child to answer. */
export interface WatchedPass {
  taskId: string;
  epicId: string;
  projectPath: string;
  model: string;
}

const watched = new Map<string, WatchedPass>();

/** Start watching a dispatched pass. Keyed by task id, so a re-dispatch for the same epic watches
 *  both — each will settle, and the LAST one to answer holds the verdict (a re-run supersedes,
 *  matching `holdVerdict`). */
export function watchAdvisorPass(pass: WatchedPass): void {
  watched.set(pass.taskId, pass);
}

/** Test seam: how many passes are currently being watched. Exists so "the entry was removed once it
 *  settled" is ASSERTABLE — without it a leak is invisible, since a settled-but-retained entry just
 *  re-settles silently on the next tick and nothing observable changes. */
export function watchedCount(): number {
  return watched.size;
}

/** Test seam: forget every watched pass. */
export function resetWatchedPasses(): void {
  watched.clear();
}

/**
 * One poll cycle: settle every watched pass whose research task has reached a TERMINAL state.
 *
 * A task that is still `queued`/`running` is left alone. A task that is `done`, `failed` or
 * `cancelled` is settled and REMOVED from the watch set — including the failure cases, because
 * "the advisor could not answer" is itself a terminal verdict (`advisor:skipped` + a note saying no
 * verdict exists) and leaving it watched would re-write that note on every subsequent tick.
 *
 * A task the reader cannot find at all (`null`) is also dropped: the record is the source of truth
 * and an id that is not in it will not appear later. Dropping it settles nothing, so the epic keeps
 * whatever terminal label the handoff already gave it — which is `advisor:skipped`, the honest state.
 */
export async function pollAdvisorTasks(
  deps: AdvisorPassDeps,
  readTask: (taskId: string) => Promise<ResearchTask | null>,
): Promise<void> {
  for (const pass of [...watched.values()]) {
    let task: ResearchTask | null = null;
    try {
      task = await readTask(pass.taskId);
    } catch (e) {
      // A transient read failure must not drop the watch — the next tick asks again.
      log.warn("advisor", "could not read an advisor research task", { task: pass.taskId, e });
      continue;
    }
    if (task === null) {
      watched.delete(pass.taskId);
      continue;
    }
    if (phaseOf(task.status) !== "terminal") continue;
    watched.delete(pass.taskId);
    try {
      await settleAdvisorPass(deps, {
        projectPath: pass.projectPath,
        epicId: pass.epicId,
        taskId: pass.taskId,
        model: pass.model,
        // `findings` is null for every non-`done` status, which is exactly the signal
        // `settleAdvisorPass` reads as "no verdict exists".
        findingsText: task.status === "done" ? task.findings : null,
      });
    } catch (e) {
      log.error("advisor", "settling an advisor pass threw", e);
    }
  }
}

/** How often the watcher asks. Far coarser than the research store's own 5s cadence, because
 *  nothing here is user-facing: a verdict that lands 20 seconds later still reaches the NEXT
 *  handoff's brief, and the bead comment is not something anyone is watching a spinner for. */
export const ADVISOR_WATCH_INTERVAL_MS = 20_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the production watcher (idempotent). Called by the first dispatch rather than at app boot,
 *  so an install that never hands an epic to Build never runs a timer for this at all. */
export function ensureAdvisorWatcher(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void pollAdvisorTasks(productionDeps(), getResearch).catch((e) =>
      log.error("advisor", "the advisor watcher crashed", e),
    );
  }, ADVISOR_WATCH_INTERVAL_MS);
}

/** Test seam / teardown: stop the production watcher. */
export function stopAdvisorWatcher(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
