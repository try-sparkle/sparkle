// apps/desktop/src/services/tasks.ts
// "Generate tasks" service: turn a synthesized PRD into a beads epic + dependency-aware child
// tasks, then write the linkage back (frontmatter epic/tasks, the PRD path into the epic body,
// decisions into Chief memories, and the epic id as a label on the PRD's Chief asset). Bead
// sparkle-hiju.7.
//
// Steps 1-5 (plan → epic → children → deps → frontmatter) are strict: errors propagate so the UI
// can surface a clean failure and nothing half-links. Step 6 (memories + label) is best-effort —
// those are enrichments, not the work graph, so a failure there must not undo the tasks.

import { invoke } from "@tauri-apps/api/core";

export interface PlannedTask {
  title: string;
  description: string;
  /** Indices (into the `tasks` array) of tasks that must finish before this one. */
  dependsOn?: number[];
}

export interface TaskPlan {
  epic: { title: string; description: string };
  tasks: PlannedTask[];
  /** Key product/technical decisions worth remembering across future think sessions. */
  decisions?: string[];
}

/** System prompt for the Claude-direct structured plan extraction. */
export const TASK_PLAN_SYSTEM = [
  "You convert a Product Requirements Document into an executable work plan.",
  "Read the PRD and output a JSON object with this exact shape:",
  '{ "epic": { "title": string, "description": string },',
  ' "tasks": [ { "title": string, "description": string, "dependsOn": number[] } ],',
  ' "decisions": string[] }.',
  "Produce between 3 and 12 tasks. Each task must be a self-contained unit of work a single",
  "engineer can complete and verify. `dependsOn` lists the array indices of tasks that must finish",
  "before this one starts (omit or use [] when independent). `decisions` captures the key product",
  "and technical decisions to remember. Output ONLY the JSON — no prose, no code fences.",
].join(" ");

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

function renderTasksArray(tasks: string[]): string {
  return `[${tasks.map((t) => JSON.stringify(t)).join(", ")}]`;
}

/**
 * Rewrite a PRD's leading YAML frontmatter `epic`/`tasks` fields with the freshly-created ids.
 * Pure (no I/O). If a leading `---` block exists, its `epic:`/`tasks:` lines are replaced (and
 * added when missing); if there is no frontmatter block, a minimal one is prepended.
 */
export function updateFrontmatter(
  markdown: string,
  patch: { epic: string; tasks: string[] },
): string {
  const epicLine = `epic: ${JSON.stringify(patch.epic)}`;
  const tasksLine = `tasks: ${renderTasksArray(patch.tasks)}`;

  const m = FRONTMATTER_RE.exec(markdown);
  if (!m) {
    // No frontmatter — prepend a minimal block.
    const block = ["---", epicLine, tasksLine, "---"].join("\n");
    return `${block}\n\n${markdown.replace(/^\s+/, "")}`;
  }

  const lines = m[1]!.split("\n");
  let sawEpic = false;
  let sawTasks = false;
  const rewritten = lines.map((line) => {
    if (/^epic:/.test(line)) {
      sawEpic = true;
      return epicLine;
    }
    if (/^tasks:/.test(line)) {
      sawTasks = true;
      return tasksLine;
    }
    return line;
  });
  if (!sawEpic) rewritten.push(epicLine);
  if (!sawTasks) rewritten.push(tasksLine);

  const newBlock = `---\n${rewritten.join("\n")}\n---`;
  return markdown.replace(FRONTMATTER_RE, newBlock);
}

export interface GenerateDeps {
  structuredJson: <T>(system: string, user: string, maxTokens?: number) => Promise<T>;
  createBeadFull: (
    projectPath: string,
    title: string,
    body: string,
    issueType: string,
    parent: string,
    deps: string,
    labels: string,
  ) => Promise<string>;
  beadDepAdd: (projectPath: string, blockedId: string, blockerId: string) => Promise<void>;
  writePrd: (projectPath: string, filename: string, content: string) => Promise<string>;
  /** Best-effort: persist a decision to Chief memories. */
  createMemory?: (content: string, category: string) => Promise<void>;
  /** Best-effort: attach the epic id as a label to the PRD's Chief asset. */
  attachLabel?: (assetId: string, name: string) => Promise<void>;
}

export interface GenerateArgs {
  projectPath: string;
  /** Bare PRD filename for the write_prd command. */
  prdFilename: string;
  /** Current PRD markdown (with the seeded frontmatter from synthesis). */
  prdContent: string;
  /** Repo-relative PRD path stored in the epic body for back-linkage. */
  prdRelPath: string;
  /** Chief asset id for the PRD (label target), when known. */
  prdAssetId?: string;
  /** Extra line(s) appended to the epic body after the PRD back-link — e.g. the capture
   *  flow's `Screenshot: <repo-relative path>` reference. */
  epicBodyExtra?: string;
}

export interface GenerateResult {
  epicId: string;
  taskIds: string[];
  updatedPrdContent: string;
}

/** Reject plans with no tasks or a title-less task BEFORE any bead is created — structuredJson
 *  returns untyped LLM output, and a task with a missing title would create an "undefined" bead. */
function validatePlanTasks(plan: TaskPlan): void {
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error("Task plan was empty or malformed (need an epic and at least one task).");
  }
  if (plan.tasks.some((t) => !t?.title || !t.title.trim())) {
    throw new Error("Task plan has a task with no title — refusing to create malformed beads.");
  }
}

/** Create the plan's child task beads under `epicId` (sequentially, so ids line up with plan
 *  indices), then add the dependency edges: task i (blocked) depends on task j (blocker). Skips
 *  self/out-of-range edges and dedupes repeated indices so an LLM emitting `dependsOn: [0, 0]`
 *  doesn't double-add. Returns the new task ids in plan order. */
async function createChildTasks(
  deps: Pick<GenerateDeps, "createBeadFull" | "beadDepAdd">,
  projectPath: string,
  epicId: string,
  plan: TaskPlan,
): Promise<string[]> {
  const taskIds: string[] = [];
  for (const t of plan.tasks) {
    const id = await deps.createBeadFull(
      projectPath,
      t.title,
      t.description ?? "",
      "task",
      epicId,
      "",
      "",
    );
    taskIds.push(id);
  }

  for (let i = 0; i < plan.tasks.length; i++) {
    const dependsOn = plan.tasks[i]!.dependsOn ?? [];
    const seen = new Set<number>();
    for (const j of dependsOn) {
      if (!Number.isInteger(j) || j < 0 || j >= taskIds.length || j === i || seen.has(j)) continue;
      seen.add(j);
      await deps.beadDepAdd(projectPath, taskIds[i]!, taskIds[j]!);
    }
  }
  return taskIds;
}

/**
 * Generate the epic + child tasks from a PRD and write back the linkage. See module header for the
 * strict-vs-best-effort split.
 */
export async function generateTasks(
  deps: GenerateDeps,
  args: GenerateArgs,
): Promise<GenerateResult> {
  const plan = await deps.structuredJson<TaskPlan>(TASK_PLAN_SYSTEM, args.prdContent);
  if (!plan?.epic?.title) {
    throw new Error("Task plan was empty or malformed (need an epic and at least one task).");
  }
  validatePlanTasks(plan);

  // 2. Epic — carries the PRD path so any bead can jump back to its spec (and the capture
  //    screenshot reference, when the caller passes one).
  const epicBody =
    `${plan.epic.description ?? ""}\n\nPRD file: ${args.prdRelPath}` +
    (args.epicBodyExtra ? `\n${args.epicBodyExtra}` : "");
  const epicId = await deps.createBeadFull(
    args.projectPath,
    plan.epic.title,
    epicBody,
    "epic",
    "",
    "",
    "think-build-loop",
  );

  // 3-4. Children + dependency edges under the fresh epic.
  const taskIds = await createChildTasks(deps, args.projectPath, epicId, plan);

  // 5. Write the epic + task ids back into the PRD frontmatter.
  const updatedPrdContent = updateFrontmatter(args.prdContent, { epic: epicId, tasks: taskIds });
  await deps.writePrd(args.projectPath, args.prdFilename, updatedPrdContent);

  // 6. Best-effort enrichment — never throw out of here.
  if (deps.createMemory) {
    for (const decision of plan.decisions ?? []) {
      try {
        await deps.createMemory(decision, "fact");
      } catch {
        // a memory write failing must not fail task generation
      }
    }
  }
  if (deps.attachLabel && args.prdAssetId) {
    try {
      await deps.attachLabel(args.prdAssetId, epicId);
    } catch {
      // labeling the PRD asset is an enrichment, not the work graph
    }
  }

  return { epicId, taskIds, updatedPrdContent };
}

// ── decomposeEpic — child tasks for an EXISTING epic (spec §7 auto-decompose) ──────────────────

/** Pull the `PRD file: <relPath>` back-link out of an epic body (written by generateTasks /
 *  capturePlan). Returns the repo-relative path plus the bare filename (what the read_prd /
 *  write_prd commands take), or null when the epic carries no PRD reference. Pure. */
export function parsePrdRef(body: string): { relPath: string; filename: string } | null {
  // Capture to end of line, not \S+ — PRD paths may contain spaces (write_prd allows them).
  const relPath = /PRD file:[ \t]*(.+)$/m.exec(body)?.[1]?.trim();
  if (!relPath) return null;
  const filename = relPath.split("/").pop();
  if (!filename) return null;
  return { relPath, filename };
}

export interface DecomposeDeps {
  structuredJson: GenerateDeps["structuredJson"];
  createBeadFull: GenerateDeps["createBeadFull"];
  beadDepAdd: GenerateDeps["beadDepAdd"];
  /** Wraps the Rust `read_prd` command; takes the BARE filename, returns the file content. */
  readPrd: (projectPath: string, filename: string) => Promise<string>;
  writePrd: GenerateDeps["writePrd"];
}

export interface DecomposeArgs {
  projectPath: string;
  /** The existing epic bead to decompose (id/title/body — the Bead shape, structurally). */
  epic: { id: string; title: string; description: string };
}

export interface DecomposeResult {
  taskIds: string[];
}

/**
 * Decompose an EXISTING epic into child task beads + dependency edges — the auto-decompose
 * counterpart of generateTasks (which creates the epic itself). Plans from the epic's PRD content
 * when the body carries a `PRD file:` back-link (falling back to title+body if the read fails or
 * no PRD exists), creates the children under the existing epic id, and writes the epic/task ids
 * back into the PRD frontmatter when a PRD was read. Errors propagate — the caller (the decompose
 * sweep) owns the guard-label bookkeeping.
 */
export async function decomposeEpic(
  deps: DecomposeDeps,
  args: DecomposeArgs,
): Promise<DecomposeResult> {
  const { projectPath, epic } = args;

  // Prefer the full PRD as planning input; a failed or EMPTY read degrades to title+body, never
  // throws — an epic whose PRD was moved/deleted/blanked still decomposes from the bead itself.
  // `prdContent !== null` is the single "a PRD was read" signal for both the plan input and the
  // write-back below.
  const ref = parsePrdRef(epic.description);
  let prdContent: string | null = null;
  if (ref) {
    try {
      const raw = await deps.readPrd(projectPath, ref.filename);
      prdContent = raw.trim() ? raw : null;
    } catch {
      prdContent = null;
    }
  }
  const planInput = prdContent ?? `# ${epic.title}\n\n${epic.description}`;

  const plan = await deps.structuredJson<TaskPlan>(TASK_PLAN_SYSTEM, planInput);
  if (!plan || typeof plan !== "object") {
    throw new Error("Task plan was empty or malformed (need an epic and at least one task).");
  }
  validatePlanTasks(plan);

  const taskIds = await createChildTasks(deps, projectPath, epic.id, plan);

  // Write-back only when we actually read a PRD: patching a file we never saw would clobber it.
  // Re-read right before patching — the AI call above takes seconds, and rewriting from the
  // planning-time snapshot would silently revert any edit made in that window. If the re-read
  // fails the planning copy still stands in (better a slightly-stale write than a lost linkage).
  if (prdContent !== null && ref) {
    const fresh = await deps.readPrd(projectPath, ref.filename).catch(() => prdContent!);
    const updated = updateFrontmatter(fresh, { epic: epic.id, tasks: taskIds });
    await deps.writePrd(projectPath, ref.filename, updated);
  }

  return { taskIds };
}

// --- thin invoke wrappers so the UI can pass real backends as deps ----------------------------

/** Read a doc from the project's `PRD/` directory. `filename` must be bare (no slashes); wraps the
 *  Rust `read_prd` command. */
export async function readPrd(projectPath: string, filename: string): Promise<string> {
  return invoke<string>("read_prd", { projectPath, filename });
}

/** Create a bead with full options; returns the new id. Wraps the Rust `create_bead_full`. */
export async function createBeadFull(
  projectPath: string,
  title: string,
  body: string,
  issueType: string,
  parent: string,
  depsCsv: string,
  labels: string,
): Promise<string> {
  const raw = await invoke<string>("create_bead_full", {
    projectPath,
    title,
    body,
    issueType,
    parent,
    deps: depsCsv,
    labels,
  });
  let obj: { id?: string; error?: string };
  try {
    obj = JSON.parse(raw) as { id?: string; error?: string };
  } catch {
    throw new Error(`Unexpected bd output: ${raw.slice(0, 200)}`);
  }
  if (obj.error) throw new Error(obj.error);
  if (obj.id) return obj.id;
  throw new Error(`bd returned no id: ${raw.slice(0, 200)}`);
}

/** Add a blocking dependency: `blockedId` depends on `blockerId`. Wraps Rust `bead_dep_add`. */
export async function beadDepAdd(
  projectPath: string,
  blockedId: string,
  blockerId: string,
): Promise<void> {
  await invoke<string>("bead_dep_add", { projectPath, blockedId, blockerId });
}
