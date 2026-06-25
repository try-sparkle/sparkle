// Personas + result contract for the build-agent orchestration system. A "worker" is a focused
// IC agent that owns exactly one task in its own worktree, then reports a structured result.
// (The orchestrator/build persona is added in Plan 2.)

/** Path, relative to a worker's worktree, where it writes its structured result as its final act. */
export const WORKER_RESULT_RELPATH = ".sparkle/result.json";

export interface WorkerResult {
  schemaVersion: 1;
  taskId: string;
  branch: string;
  status: "success" | "failed" | "partial";
  filesChanged: string[];
  summary: string;
  notes?: string;
}

const STATUSES = ["success", "failed", "partial"] as const;

/** Parse + validate a worker's result.json. Throws Error naming the first offending field. */
export function parseWorkerResult(raw: string): WorkerResult {
  const o = JSON.parse(raw);
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    throw new Error("result must be a JSON object");
  }
  const obj = o as Record<string, unknown>;
  if (obj.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (typeof obj.taskId !== "string" || !obj.taskId) throw new Error("taskId is required");
  if (typeof obj.branch !== "string" || !obj.branch) throw new Error("branch is required");
  if (typeof obj.status !== "string" || !STATUSES.includes(obj.status as never)) {
    throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  }
  if (!Array.isArray(obj.filesChanged) || obj.filesChanged.some((f) => typeof f !== "string")) {
    throw new Error("filesChanged must be a string[]");
  }
  if (typeof obj.summary !== "string" || !obj.summary) throw new Error("summary is required");
  if (obj.notes !== undefined && typeof obj.notes !== "string") throw new Error("notes must be a string");
  return {
    schemaVersion: 1,
    taskId: obj.taskId,
    branch: obj.branch,
    status: obj.status as WorkerResult["status"],
    filesChanged: obj.filesChanged as string[],
    summary: obj.summary,
    ...(obj.notes !== undefined ? { notes: obj.notes as string } : {}),
  };
}

/** System prompt that turns a plain `claude` session into a single-task worker IC. */
export function workerPersona(opts: { parentBranch: string; resultPath: string }): string {
  return [
    "You are a Sparkle WORKER agent — a focused individual contributor.",
    "",
    "SCOPE",
    "- You own exactly ONE task, described in the first message. Do that task and nothing more.",
    `- You work in your own isolated git worktree on your own branch, cut from the parent branch`,
    `  ${opts.parentBranch}. Commit your work to your branch.`,
    "- Do NOT spawn or delegate to other workers. You are a leaf. (You may use built-in subagents",
    "  for read-only research, but all edits are yours.)",
    "",
    "FINISHING — THIS IS REQUIRED",
    "As your FINAL act, after committing, write a JSON result file to this exact path:",
    `  ${opts.resultPath}`,
    "with this shape (schemaVersion is the number 1):",
    '  { "schemaVersion": 1, "taskId": "<the id from the Task <id>: line of your first message>",',
    '    "branch": "<your git branch>", "status": "success" | "failed" | "partial",',
    '    "filesChanged": ["path", ...], "summary": "<one-paragraph what you did>",',
    '    "notes": "<optional caveats / follow-ups>" }',
    "Create the .sparkle directory if needed. Then stop.",
  ].join("\n");
}

/** The one-shot task prompt submitted on launch (the worker's first message).
 *  Puts the taskId on its own leading line so the worker can echo it back unambiguously. */
export function workerMission(task: string, taskId: string): string {
  return `Task ${taskId}:\n${task}`;
}
