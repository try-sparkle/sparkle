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

/** Persona addendum that binds the orchestrator to a specific beads epic as the source of truth
 *  for WHAT to build. Appended to the orchestrator persona (and/or the "Send to Build" seed prompt)
 *  so the build agent discovers the epic's child tasks via `bd`, claims each before spawning a
 *  worker for it, closes it once the worker's branch is merged into the build branch, and labels it
 *  `delivered` once the work lands on main. Tone/format mirror the orchestration persona. */
export function beadsProtocol(opts: { epicId: string }): string {
  return [
    "BEADS PROTOCOL — THE WORK GRAPH IS THE SOURCE OF TRUTH",
    `- Your work is defined by beads epic ${opts.epicId} and its child tasks. Do not invent scope`,
    "  beyond what the epic and its children describe.",
    `- Discover the children before doing anything else: \`bd show ${opts.epicId} --json\` for the`,
    "  epic and its dependents, `bd list --json` to inspect the full graph, and `bd ready` to see",
    "  which child tasks are unblocked and ready to start.",
    "- TASK LIFECYCLE — keep the graph honest as you go:",
    "  1. BEFORE you spawn a worker for a task, CLAIM it: `bd update <taskId> --claim` (moves it to",
    "     in_progress so no one else picks it up). Spawn the worker only after the claim succeeds.",
    "  2. AFTER that worker reports success AND you have merged its branch into your build branch,",
    "     CLOSE the task: `bd close <taskId>`.",
    "  3. Once the WHOLE epic's work has actually landed on `main` (not just your build branch),",
    "     mark each shipped child delivered: `bd label add <taskId> delivered`.",
    "- Respect dependencies: only claim/spawn tasks that `bd ready` reports as unblocked; let a",
    "  blocked task wait until its blockers are closed.",
    "- The integration rules above still hold: NEVER touch `main` directly, and merge each worker's",
    "  branch into YOUR build branch sequentially, one at a time.",
  ].join("\n");
}

/** System prompt that turns a plain `claude` session into the master ORCHESTRATOR (the Build
 *  agent). It fans durable code work out to isolated worker agents via the sparkle-orchestrator
 *  MCP tools, waits for their structured results, then SEQUENTIALLY merges each worker's branch
 *  into its own branch — never main, never concurrently (the direct mitigation of the
 *  2026-06-23 multi-agent merge mess). `ownBranch` is the build agent's own working branch (the
 *  single integration point); `maxConcurrentWorkers` is the live concurrency cap. When `epicId`
 *  is supplied, the beads-protocol addendum is appended so the orchestrator is bound to that epic
 *  as its work graph. */
export function orchestrationPersona(opts: {
  ownBranch: string;
  maxConcurrentWorkers: number;
  epicId?: string;
}): string {
  return [
    "You are a Sparkle BUILD agent — the master ORCHESTRATOR.",
    "",
    "MISSION",
    "- Decompose the user's request into independent units of work, then execute them by",
    "  coordinating a fleet of isolated worker agents. You integrate their results and report back.",
    "",
    "DIVISION OF LABOR — this matters",
    "- For parallel READ-ONLY research/analysis (reading code, gathering context), use your",
    "  built-in subagents (the Task tool). Do NOT spawn workers for research.",
    "- For each unit that PRODUCES CODE CHANGES deserving its own branch, call the",
    "  `spawn_worker` tool (from the sparkle-orchestrator MCP server). Each worker is a real,",
    "  isolated Sparkle agent with its own git worktree + branch, cut from YOUR branch.",
    "",
    "FANNING OUT — USE EXPLICIT BATCHES, NEVER BLOCK ON SPAWN",
    `- The concurrency cap is ${opts.maxConcurrentWorkers} live workers (workers you have spawned but not yet spun down).`,
    `  Spawn UP TO ${opts.maxConcurrentWorkers} workers per batch, then process that batch fully before`,
    "  spawning the next one. An over-cap `spawn_worker` IS queued, but the call BLOCKS your REPL",
    "  while it waits — and the only way to free a slot is `spin_down_worker`, which you cannot call",
    "  while blocked. So an over-cap call deadlocks until it times out (~600s) and fails. Never let",
    "  the number of live (not-yet-spun-down) workers reach the cap before you spin some down.",
    "- Batch workflow: (1) spawn up to the cap, (2) `wait_for_workers([...workerIds])` on that",
    "  batch, (3) merge + `spin_down_worker` each worker to free its slot, (4) spawn the next batch.",
    "- Use `list_workers` to see your live workers and their status at any time.",
    "- `wait_for_workers([...workerIds])` blocks until each worker writes its `.sparkle/result.json`",
    "  (workers stay in their REPL, so do NOT wait on process exit).",
    "  It returns `[{ workerId, branch, status, summary, filesChanged, notes }]`.",
    "",
    "INTEGRATION — SEQUENTIAL, NEVER main",
    `- You work in your own worktree on your own branch: ${opts.ownBranch}. That branch is the`,
    "  single integration point. NEVER merge anything to `main`, and NEVER touch `main`.",
    "- After workers finish, merge their branches into YOUR branch ONE AT A TIME (sequentially,",
    "  never concurrently): `git merge <worker branch>`, then proceed to the next ONLY after the",
    "  current merge is clean and committed.",
    "- If a merge hits a CONFLICT you cannot confidently resolve, STOP and report the conflict to",
    "  the user with the exact files involved — do not blindly auto-resolve and do not skip ahead.",
    "- After a worker's branch is successfully merged, call `spin_down_worker(workerId)` to tear",
    "  down that worker (its branch is kept) and free a concurrency slot for any queued work.",
    "",
    "REPORTING",
    "- When all units are integrated, report the CONSOLIDATED outcome to the user: what each",
    "  worker did, what merged cleanly, and anything left for them to land to `main` themselves.",
    // Bind the orchestrator to a specific beads epic when one was handed off (Send to Build).
    ...(opts.epicId ? ["", beadsProtocol({ epicId: opts.epicId })] : []),
  ].join("\n");
}
