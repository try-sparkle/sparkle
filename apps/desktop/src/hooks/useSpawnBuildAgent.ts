// Spawn a Build agent from anywhere in the UI (the sidebar's "+ New Build Agent" row, the
// empty-state start button on the Workspace, and the drop-files-on-the-button flow all share this
// one implementation). Returns the new agent's id (null with no project open) so callers that need
// to address the agent — e.g. queueing dropped files for its composer — can; button onClick callers
// just ignore it.
//
// The sequence itself lives in services/buildAgentSpawn so NON-React callers (the concierge's
// lifecycle tools) run the same one instead of a copy. This hook is the React doorway to it.
import { spawnBuildAgentInProject } from "../services/buildAgentSpawn";
import { isBeadsUnavailable } from "../services/beads";
import type { Project } from "../types";

// The "project has no beads DB" predicate lives with the bead service (its canonical home, and to
// avoid a store→hook import cycle now that runtimeStore reuses it too). Re-exported here so existing
// callers and tests that import it from this module keep working.
export { isBeadsUnavailable };

/** The options this hook accepts. Narrow on purpose — see {@link spawnOptsOf}. */
export interface SpawnBuildAgentOpts {
  epicId?: string;
}

/**
 * Keep ONLY the fields that are really spawn options, and drop anything else entirely.
 *
 * THE HAZARD THIS CLOSES. The callback this hook returns is handed straight to a DOM `onClick` —
 * `Workspace.tsx` passes it as `NewAgentButtons.onLocalClick`, which is typed `() => void` and
 * wired to a real `<button>`. TypeScript therefore never sees React handing it a SyntheticEvent,
 * and without this the EVENT IS THE OPTIONS OBJECT. Today that is harmless because no event field
 * is named `epicId`; it stops being harmless the first time a field name collides, and the failure
 * would be a spawn silently attributed to the wrong epic.
 *
 * Rebuilding the object from known keys rather than sniffing for event-ish properties is the
 * stricter direction: a foreign object degrades to `undefined` whatever it contains, so no future
 * field can collide. Note React 17+ events are plain objects, so an `instanceof Event` test would
 * not have caught this at all.
 */
function spawnOptsOf(opts: SpawnBuildAgentOpts | undefined): SpawnBuildAgentOpts | undefined {
  if (!opts || typeof opts !== "object") return undefined;
  return typeof opts.epicId === "string" ? { epicId: opts.epicId } : undefined;
}

export function useSpawnBuildAgent(
  project: Project | null,
): (opts?: SpawnBuildAgentOpts) => string | null {
  // `opts.epicId` names an epic to spawn this agent AGAINST: the auto-minted bead is parented to it
  // and the agent's `epicId` is set, so `agentsForEpicSlices` finds it and the epic square leaves gray
  // (sparkle-f2tzxg). Omitted (the empty-state and drop callers), the spawn is a top-level agent as
  // before — the field is optional and defaults to today's behaviour.
  return (opts) => (project ? spawnBuildAgentInProject(project, spawnOptsOf(opts)) : null);
}
