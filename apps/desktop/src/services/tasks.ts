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
import type { Metering } from "./anthropic";
import { projectNameForPath } from "./creditProject";
import { loadEpicPrdIndex, resolveEpicPrdRef, setEpicPrd } from "./epicPrd";

/** Re-exported so every existing importer (and `tasks.test.ts`) keeps reading it from here. The
 *  implementation moved to `epicPrd.ts` — the module that owns the structured-first resolve rule —
 *  so that this file and that one need not import each other. It is the FALLBACK half of that rule
 *  and is deliberately kept: thousands of epics carry their PRD only as this prose line. */
export { parsePrdRef } from "./epicPrd";

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

/**
 * Multi-epic plan — the shape `generateTasks` now asks the model for. A PRD decomposes into ONE OR
 * MORE coherent epics, each with its own self-contained task list (with per-epic `dependsOn` indices
 * that are LOCAL to that epic's tasks). A focused PRD stays a single epic — this is a strict
 * superset of `TaskPlan`, so the one-epic path behaves exactly as before. Kept SEPARATE from
 * `TaskPlan`: the auto-decompose watcher (decomposeEpic) still uses TaskPlan/TASK_PLAN_SYSTEM.
 */
export interface EpicPlan {
  epics: { title: string; description: string; tasks: PlannedTask[] }[];
  /** Key product/technical decisions worth remembering across future think sessions. */
  decisions?: string[];
}

/** System prompt for the Claude-direct structured plan extraction (single epic — used by the
 *  auto-decompose watcher). */
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

/** System prompt for the multi-epic plan extraction used by generateTasks. Instructs the model to
 *  split a PRD into 1..N epics, only using more than one when the PRD genuinely spans independent
 *  deliverables — a focused PRD stays a single epic. */
export const EPIC_PLAN_SYSTEM = [
  "You convert a Product Requirements Document into an executable work plan of one or more epics.",
  "Read the PRD and output a JSON object with this exact shape:",
  '{ "epics": [ { "title": string, "description": string,',
  ' "tasks": [ { "title": string, "description": string, "dependsOn": number[] } ] } ],',
  ' "decisions": string[] }.',
  "Split the PRD into 1 to N coherent epics. Use MORE THAN ONE epic ONLY when the PRD genuinely",
  "spans independent deliverables that could each ship on their own; PREFER a SINGLE epic for a",
  "focused PRD. Give each epic between 2 and 12 self-contained tasks a single engineer can complete",
  "and verify. Within an epic, `dependsOn` lists the array indices of tasks IN THAT SAME EPIC that",
  "must finish before this one starts — indices are LOCAL to that epic's task list (omit or use []",
  "when independent). `decisions` captures the key product and technical decisions to remember.",
  "Output ONLY the JSON — no prose, no code fences.",
].join(" ");

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

function renderTasksArray(tasks: string[]): string {
  return `[${tasks.map((t) => JSON.stringify(t)).join(", ")}]`;
}

/**
 * Rewrite a PRD's leading YAML frontmatter `epic`/`tasks` (and optionally `epics`) fields with the
 * freshly-created ids. Pure (no I/O). If a leading `---` block exists, the matching lines are
 * replaced (and added when missing); if there is no frontmatter block, a minimal one is prepended.
 *
 * `epic:` (the first epic) and `tasks:` (all child tasks) are ALWAYS written so nothing that reads
 * the old fields breaks. `epics:` (the full epic-id list) is written only when the caller passes it —
 * additive, so the single-field callers (decomposeEpic, the unit tests) stay byte-for-byte the same.
 */
export function updateFrontmatter(
  markdown: string,
  patch: { epic: string; tasks: string[]; epics?: string[] },
): string {
  const epicLine = `epic: ${JSON.stringify(patch.epic)}`;
  const tasksLine = `tasks: ${renderTasksArray(patch.tasks)}`;
  const epicsLine = patch.epics ? `epics: ${renderTasksArray(patch.epics)}` : null;

  const m = FRONTMATTER_RE.exec(markdown);
  if (!m) {
    // No frontmatter — prepend a minimal block.
    const block = ["---", epicLine, tasksLine, ...(epicsLine ? [epicsLine] : []), "---"].join("\n");
    return `${block}\n\n${markdown.replace(/^\s+/, "")}`;
  }

  const lines = m[1]!.split("\n");
  let sawEpic = false;
  let sawTasks = false;
  let sawEpics = false;
  const rewritten = lines.map((line) => {
    // Check `epics:` before `epic:` — `/^epic:/` wouldn't match "epics:" anyway, but order makes
    // the intent explicit. When the caller omits `epics`, an existing `epics:` line is left as-is.
    if (epicsLine !== null && /^epics:/.test(line)) {
      sawEpics = true;
      return epicsLine;
    }
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
  if (epicsLine !== null && !sawEpics) rewritten.push(epicsLine);

  const newBlock = `---\n${rewritten.join("\n")}\n---`;
  return markdown.replace(FRONTMATTER_RE, newBlock);
}

export interface GenerateDeps {
  structuredJson: <T>(system: string, user: string, maxTokens?: number, metering?: Metering) => Promise<T>;
  createBeadFull: (
    projectPath: string,
    title: string,
    body: string,
    issueType: string,
    parent: string,
    deps: string,
    labels: string,
    priority?: string,
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
  /** Every epic bead created for this PRD, in plan order. */
  epicIds: string[];
  /** = epicIds[0]. Kept for backward compatibility with the many consumers that read a single
   *  epic id (sendToBuild, the Plan view). */
  epicId: string;
  /** All child task ids across every epic, flattened in epic order. */
  taskIds: string[];
  updatedPrdContent: string;
}

/** Reject task lists with no tasks or a title-less task BEFORE any bead is created — structuredJson
 *  returns untyped LLM output, and a task with a missing title would create an "undefined" bead.
 *  Structural `{ tasks }` param so it validates both a TaskPlan and a single EpicPlan epic. */
function validatePlanTasks(plan: { tasks: PlannedTask[] }): void {
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error("Task plan was empty or malformed (need an epic and at least one task).");
  }
  if (plan.tasks.some((t) => !t?.title || !t.title.trim())) {
    throw new Error("Task plan has a task with no title — refusing to create malformed beads.");
  }
}

/** Reject a multi-epic plan with no epics, a title-less epic, or any epic that fails the per-epic
 *  task validation — again BEFORE any bead is created. Reuses validatePlanTasks per epic. */
function validateEpicPlan(plan: EpicPlan): void {
  if (!Array.isArray(plan.epics) || plan.epics.length === 0) {
    throw new Error("Task plan was empty or malformed (need an epic and at least one task).");
  }
  for (const epic of plan.epics) {
    if (!epic?.title || !epic.title.trim()) {
      throw new Error("Task plan was empty or malformed (need an epic and at least one task).");
    }
    validatePlanTasks(epic);
  }
}

/** Coerce raw structuredJson output into an EpicPlan. Accepts the native multi-epic shape (an
 *  `epics` array) or a legacy single-epic `{ epic, tasks }` shape (which some prompts/models still
 *  emit), wrapping the latter into a one-element `epics` list. Anything else yields an empty plan so
 *  validateEpicPlan throws the standard error. Missing epic titles/descriptions are normalized to
 *  "" and left for validation to reject / the body builder to tolerate — matching the old flow. */
function toEpicPlan(raw: unknown): EpicPlan {
  const p = raw as
    | {
        epics?: EpicPlan["epics"];
        epic?: { title?: string; description?: string };
        tasks?: PlannedTask[];
        decisions?: string[];
      }
    | null
    | undefined;
  if (p && Array.isArray(p.epics)) {
    return { epics: p.epics, decisions: p.decisions };
  }
  if (p && p.epic) {
    return {
      epics: [
        {
          title: p.epic.title ?? "",
          description: p.epic.description ?? "",
          tasks: Array.isArray(p.tasks) ? p.tasks : [],
        },
      ],
      decisions: p.decisions,
    };
  }
  return { epics: [] };
}

/** Create the plan's child task beads under `epicId` (sequentially, so ids line up with plan
 *  indices), then add the dependency edges: task i (blocked) depends on task j (blocker). Skips
 *  self/out-of-range edges and dedupes repeated indices so an LLM emitting `dependsOn: [0, 0]`
 *  doesn't double-add. Returns the new task ids in plan order. */
async function createChildTasks(
  deps: Pick<GenerateDeps, "createBeadFull" | "beadDepAdd">,
  projectPath: string,
  epicId: string,
  plan: { tasks: PlannedTask[] },
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
 * Record an epic's PRD path as structured bd metadata, swallowing any failure.
 *
 * The ONE place this file writes the field, shared by `generateTasks` (recording it as the epic is
 * created) and `decomposeEpic` (backfilling it for an epic that only ever had the prose line). Not
 * a seam on an injected deps object: this is a single Tauri command with no alternative
 * implementation, and a defaulted seam every test overrides would leave the line that supplies the
 * real value covered by nothing.
 */
async function recordEpicPrd(projectPath: string, epicId: string, prdPath: string): Promise<void> {
  try {
    await setEpicPrd(projectPath, epicId, prdPath);
  } catch {
    // A structured PRD path is an improvement on the prose back-link, never a precondition of one.
  }
}

/**
 * Generate the epic + child tasks from a PRD and write back the linkage. See module header for the
 * strict-vs-best-effort split.
 */
export async function generateTasks(
  deps: GenerateDeps,
  args: GenerateArgs,
): Promise<GenerateResult> {
  const plan = toEpicPlan(
    await deps.structuredJson<EpicPlan>(EPIC_PLAN_SYSTEM, args.prdContent, undefined, {
      purpose: "Planning tasks from your prompt",
      // Resolved from the path the caller already passes, so no call site has to thread a name.
      project: projectNameForPath(args.projectPath),
    }),
  );
  validateEpicPlan(plan);

  // 2-4. One epic bead per plan epic, each with its own children + LOCAL dependency edges. Every
  //      epic body carries the SAME `PRD file:` back-link so all epics link to the one PRD (the
  //      PRD-level "Build all epics" filter relies on it); the `epicBodyExtra` line (e.g. the
  //      capture screenshot ref) applies to the FIRST epic only.
  const epicIds: string[] = [];
  const taskIds: string[] = [];
  for (let e = 0; e < plan.epics.length; e++) {
    const epic = plan.epics[e]!;
    const epicBody =
      `${epic.description ?? ""}\n\nPRD file: ${args.prdRelPath}` +
      (e === 0 && args.epicBodyExtra ? `\n${args.epicBodyExtra}` : "");
    const epicId = await deps.createBeadFull(
      args.projectPath,
      epic.title,
      epicBody,
      "epic",
      "",
      "",
      "think-build-loop",
    );
    epicIds.push(epicId);
    // ── THE STRUCTURED HALF OF THE SAME BACK-LINK ────────────────────────────────────────────
    // Written HERE, one line after the prose `PRD file:` line above, deliberately: metadata and
    // prose are recorded from the SAME `args.prdRelPath` at the SAME moment, so the two can never
    // disagree about an epic this app created. Anywhere else and they would be two writes with a
    // window between them.
    //
    // BEST-EFFORT, in the shape of step 6 below: a bd write that fails (a busy single-writer store
    // is routine here) must not undo an epic whose beads and children already exist. The prose
    // back-link is still in the body, and `resolveEpicPrdRef` falls back to it — which is exactly
    // why the failure is survivable rather than merely tolerated.
    await recordEpicPrd(args.projectPath, epicId, args.prdRelPath);
    const childIds = await createChildTasks(deps, args.projectPath, epicId, epic);
    taskIds.push(...childIds);
  }
  const primaryEpicId = epicIds[0]!;

  // 5. Write the epic ids + flattened task ids back into the PRD frontmatter. `epic:`/`tasks:` keep
  //    their existing meaning (first epic / all tasks); `epics:` is the full epic-id list.
  const updatedPrdContent = updateFrontmatter(args.prdContent, {
    epic: primaryEpicId,
    tasks: taskIds,
    epics: epicIds,
  });
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
      await deps.attachLabel(args.prdAssetId, primaryEpicId);
    } catch {
      // labeling the PRD asset is an enrichment, not the work graph
    }
  }

  return { epicIds, epicId: primaryEpicId, taskIds, updatedPrdContent };
}

// ── decomposeEpic — child tasks for an EXISTING epic (spec §7 auto-decompose) ──────────────────

export interface DecomposeDeps {
  structuredJson: GenerateDeps["structuredJson"];
  createBeadFull: GenerateDeps["createBeadFull"];
  beadDepAdd: GenerateDeps["beadDepAdd"];
  /** Wraps the Rust `read_prd` command; takes the BARE filename, returns the file content. */
  readPrd: (projectPath: string, filename: string) => Promise<string>;
  writePrd: GenerateDeps["writePrd"];
  /**
   * OPTIONAL — the second-model advisor's HIGH findings on this epic's plan (bead `sparkle-revqiv`).
   *
   * ══ WHY THE REVISION ROUND LIVES HERE, AND ONLY HERE ═══════════════════════════════════════════
   *
   * This is the one moment a plan can still be REVISED before any bead is written. Everywhere else
   * the advisor is purely advisory — it comments, the orchestrator decides — because by then the
   * work graph exists and rewriting it would put a second, unrecorded author on it.
   *
   * ══ EXACTLY ONE ROUND, BOUNDED DELIBERATELY ════════════════════════════════════════════════════
   *
   * Not "revise until the advisor is quiet". `.roborev.toml` measured that loop over 6,281 reviews
   * and it DOES NOT CONVERGE: 61.6% fail on the first round, then 53.5, 46.2, 46.0 … and a plateau
   * around 40-48% that holds through at least the fourteenth. Every revision is itself reviewable,
   * so each round has a coin-flip chance of producing new findings indefinitely. A "keep going until
   * it is clean" loop burns a whole session and is still not clean — that is a property of the loop,
   * not a sign of being close. So: one round, then proceed.
   *
   * ══ ABSENT BY DEFAULT, AND THAT IS NOT AN OVERSIGHT ════════════════════════════════════════════
   *
   * With this dep unset `decomposeEpic` behaves EXACTLY as it did before the advisor existed — one
   * `structuredJson` call, the same four arguments — so every pre-existing caller and test is
   * untouched. It is a seam on the injected deps object rather than a value read inline at the call
   * site, which is the shape AGENTS.md prescribes so a single test can drive the production path.
   *
   * Returns `null` when there is nothing to revise for: no verdict held, or none of its findings are
   * `high`. It is NEVER awaited on a network call in production — the wiring reads a verdict already
   * delivered by a pass dispatched earlier, so this adds no stall to a decompose.
   *
   * ══ THE ORDERING THIS REQUIRES, AND WHY IT IS RARE TODAY ═══════════════════════════════════════
   *
   * A verdict only exists for an epic that has ALREADY been handed off once and whose research child
   * has since answered — `prepareHandoff` is the only dispatcher, and the child takes minutes. So on
   * the ordinary Plan → decompose → Build order this returns `null` every time, because no pass has
   * been dispatched for that epic yet. It becomes live on the RE-decompose paths: an epic sent to
   * Build, then decomposed again after its pass answered.
   *
   * That is a real limit and it is stated here rather than implied by the tests. Making the round
   * routine means dispatching at the decompose seam and WAITING for a verdict, which trades the
   * "never blocks" property for it — a deliberate design decision, not a wiring fix, and out of
   * scope for the branch that introduced this. Tracked on bead `sparkle-revqiv`.
   */
  advisorRevisionNote?: (epicId: string) => Promise<string | null>;
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
 * when the epic HAS a PRD — structured `prd` metadata first, the prose `PRD file:` back-link as
 * fallback (falling back to title+body if the read fails or no PRD exists) — creates the children
 * under the existing epic id, and writes the epic/task ids back into the PRD frontmatter when a
 * PRD was read. Errors propagate — the caller (the decompose
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
  //
  // STRUCTURED FIRST, PROSE ONLY AS FALLBACK — `resolveEpicPrdRef` is the one rule, shared with
  // the epic ladder, the Build It hook and the stall sweep. `loadEpicPrdIndex` never throws: a bd
  // read that fails yields an empty index, which is the behaviour this function had before the
  // field existed.
  const prdIndex = await loadEpicPrdIndex(projectPath);
  const ref = resolveEpicPrdRef(epic, prdIndex);
  let prdContent: string | null = null;
  if (ref) {
    try {
      const raw = await deps.readPrd(projectPath, ref.filename);
      prdContent = raw.trim() ? raw : null;
    } catch {
      prdContent = null;
    }
  }
  // THE BACKFILL, and the only write path that is reachable in the shipped app today (see the
  // `generateTasks` note — its own caller chain has no importer). Recording the path as structured
  // metadata makes it retrievable by a future agent's `bd show` without asking anyone to re-derive
  // it. Only when the index did NOT already carry it, so this is one write per epic for the whole
  // life of the epic rather than one per decompose.
  //
  // GATED ON `prdContent`, NOT ON `ref` — and the difference is not cosmetic. The `readPrd` above
  // deliberately TOLERATES a PRD that was moved, deleted or blanked by setting `prdContent = null`
  // and carrying on, so `ref` alone proves only that the prose carries a `PRD file:` line, never
  // that the line still points at anything. Promoting an unread path would freeze a DEAD path into
  // the shared Dolt store, where `resolveEpicPrdRef` is structured-first and this backfill is
  // one-shot: every reader — Build It, the ladder drop, the sweep restart and `decomposeEpic`
  // itself — would then be handed the stale path forever, outranking a prose line a human later
  // corrected, and `set_epic_prd` deliberately offers no unset to undo it. So only a path that was
  // just proved to resolve to real content earns the promotion.
  // `ref &&` is redundant at RUNTIME — `prdContent` is only ever set inside the `if (ref)` above —
  // but the compiler cannot carry that narrowing across the two statements, and `ref.relPath`
  // below is a deref. Kept explicit rather than asserted with `!`, so a future edit that decouples
  // the two is a type error here instead of a null deref at runtime.
  if (prdContent !== null && ref && !prdIndex.get(epic.id)?.trim()) {
    await recordEpicPrd(projectPath, epic.id, ref.relPath);
  }
  const planInput = prdContent ?? `# ${epic.title}\n\n${epic.description}`;

  const meta = {
    purpose: `Breaking down the "${epic.title}" epic into tasks`,
    project: projectNameForPath(projectPath),
  };
  let plan = await deps.structuredJson<TaskPlan>(TASK_PLAN_SYSTEM, planInput, undefined, meta);
  if (!plan || typeof plan !== "object") {
    throw new Error("Task plan was empty or malformed (need an epic and at least one task).");
  }
  validatePlanTasks(plan);

  // ── THE ONE ADVISOR REVISION ROUND ────────────────────────────────────────────────────────────
  // See `DecomposeDeps.advisorRevisionNote` for why it is exactly one and why it is optional. The
  // note is appended to the SAME planning input and the planner is asked again with the SAME four
  // arguments — the advisor never rewrites a plan itself, it only tells the planner what it found.
  //
  // BEST-EFFORT: a failure here (the note could not be read, the revised plan came back malformed)
  // keeps the ORIGINAL plan rather than failing the decompose. A second opinion that cannot be
  // obtained must not cost the founder a decomposition that already succeeded — the same failure
  // contract the rest of the advisor follows.
  if (deps.advisorRevisionNote) {
    try {
      const note = await deps.advisorRevisionNote(epic.id);
      if (note?.trim()) {
        const revised = await deps.structuredJson<TaskPlan>(
          TASK_PLAN_SYSTEM,
          `${planInput}

${note.trim()}`,
          undefined,
          meta,
        );
        if (revised && typeof revised === "object") {
          validatePlanTasks(revised);
          plan = revised;
        }
      }
    } catch {
      // Keep the original plan. Deliberately swallowed rather than logged from here: this module is
      // pure-ish and its caller (the decompose sweep) owns the failure reporting.
    }
  }

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

/** Create a bead with full options; returns the new id. Wraps the Rust `create_bead_full`.
 *
 *  `priority` is LAST and optional so every existing call site keeps its meaning unchanged. It is
 *  a plain string, and an EMPTY one means "say nothing, let bd default" — the Rust side appends
 *  `-p` only for a non-blank value. It is deliberately NOT `number | undefined`: the Rust command
 *  takes a `String`, and a `serde` `Option` would cross the wire as `null` rather than an absent
 *  key, which is the shape that silently fails to parse (see AGENTS.md). One string, always sent.
 *
 *  Before this existed the priority could not be expressed at all, so a caller asking for P1 got
 *  bd's default P2 with nothing logged (`sparkle-1abg72`). */
export async function createBeadFull(
  projectPath: string,
  title: string,
  body: string,
  issueType: string,
  parent: string,
  depsCsv: string,
  labels: string,
  priority = "",
): Promise<string> {
  const raw = await invoke<string>("create_bead_full", {
    projectPath,
    title,
    body,
    issueType,
    priority,
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
