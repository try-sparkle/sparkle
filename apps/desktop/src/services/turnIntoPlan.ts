// "Turn this into a Plan" — the single Think action that composes PRD synthesis and task
// generation into one step: a Think conversation becomes a beads epic + child tasks (the epic is
// the parent), ready to view in Plan and hand to Build. Composition only (no I/O of its own) so the
// whole Think→Plan pipeline is unit-testable end to end; the UI passes the real synthesize/generate
// backends as deps.
//
// Errors propagate: synthesis must succeed before any bead is created, so a failure surfaces to the
// UI without half-linking the work graph (generateTasks' own steps 1–5 are likewise strict).
import type { SynthesizeArgs, SynthesizeResult } from "./prd";
import type { GenerateArgs, GenerateResult } from "./tasks";

export interface TurnIntoPlanDeps {
  /** Synthesize the interview transcript into a PRD (typically `(a) => synthesizePrd(realDeps, a)`). */
  synthesize: (args: SynthesizeArgs) => Promise<SynthesizeResult>;
  /** Decompose the PRD into an epic + child beads (typically `(a) => generateTasks(realDeps, a)`). */
  generate: (args: GenerateArgs) => Promise<GenerateResult>;
}

export interface TurnIntoPlanArgs {
  pat: string;
  chiefProjectId: string;
  projectPath: string;
  /** The Think interview transcript so far. */
  transcript: string;
}

export interface TurnIntoPlanResult {
  /** Every epic the PRD decomposed into (usually one). */
  epicIds: string[];
  /** = epicIds[0]. Kept for the callers that route a single epic to the Plan/Build steps. */
  epicId: string;
  /** The epic title (from the PRD's h1) — also the Think agent's auto-name basis. */
  epicTitle: string;
  taskIds: string[];
  /** Repo-relative PRD path — pass straight to sendToBuild for the "Build It" step. */
  prdPath: string;
  prdFilename: string;
}

/**
 * Run the Think→Plan pipeline: synthesize the interview into a PRD, then decompose it into a beads
 * epic + dependency-aware child tasks. Returns the epic id/title, child task ids, and the PRD path
 * so the caller can route to the Plan view and later hand the epic to Build ("Build It").
 */
export async function turnIntoPlan(
  deps: TurnIntoPlanDeps,
  args: TurnIntoPlanArgs,
): Promise<TurnIntoPlanResult> {
  const prd = await deps.synthesize({
    pat: args.pat,
    chiefProjectId: args.chiefProjectId,
    projectPath: args.projectPath,
    transcript: args.transcript,
  });
  const gen = await deps.generate({
    projectPath: args.projectPath,
    prdFilename: prd.filename,
    prdContent: prd.content,
    prdRelPath: prd.path,
  });
  // `?? [gen.epicId]` tolerates a generate backend that predates the epicIds field (e.g. a test
  // double returning the old shape) — the real generateTasks always supplies epicIds.
  const epicIds = gen.epicIds ?? [gen.epicId];
  return {
    epicIds,
    epicId: gen.epicId,
    epicTitle: prd.title,
    taskIds: gen.taskIds,
    prdPath: prd.path,
    prdFilename: prd.filename,
  };
}
