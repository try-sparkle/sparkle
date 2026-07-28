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

export function useSpawnBuildAgent(project: Project | null): () => string | null {
  return () => (project ? spawnBuildAgentInProject(project) : null);
}
