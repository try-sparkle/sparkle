// Spawn a Build agent from anywhere in the UI (the sidebar's "+ New Build Agent" row, the
// empty-state start button on the Workspace, and the drop-files-on-the-button flow all share this
// one implementation). Creating the agent is synchronous (immediately usable); a bead is created
// async + best-effort and attached when `bd` returns — a build agent without a bead is still fine
// if bd is unavailable. Leaving the special (Sparkle/board) view is part of "start a build
// agent", so it's folded in here too. Returns the new agent's id (null with no project open) so
// callers that need to address the agent — e.g. queueing dropped files for its composer — can;
// button onClick callers just ignore it.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { createBeadFull } from "../services/tasks";
import { isBeadsUnavailable } from "../services/beads";
import { log } from "../logger";
import { perfStart } from "../perfTrace";
import type { Project } from "../types";

// The "project has no beads DB" predicate lives with the bead service (its canonical home, and to
// avoid a store→hook import cycle now that runtimeStore reuses it too). Re-exported here so existing
// callers and tests that import it from this module keep working.
export { isBeadsUnavailable };

export function useSpawnBuildAgent(project: Project | null): () => string | null {
  const addAgent = useProjectStore((s) => s.addAgent);
  const selectAgent = useProjectStore((s) => s.selectAgent);
  const setAgentBeadId = useProjectStore((s) => s.setAgentBeadId);
  const open = useRuntimeStore((s) => s.open);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);
  return () => {
    if (!project) return null;
    const proj = project;
    setActiveSpecial(null); // creating an agent leaves the special (Sparkle/board) view
    const id = addAgent(proj.id, { kind: "build" });
    // Start the spawn-latency waterfall the instant the click adds the agent — AgentPane.prepare()
    // and Terminal add the remaining milestones through to "pty ready" under the same key (perfTrace).
    perfStart(id, "spawn", { kind: "build" });
    selectAgent(proj.id, id);
    open(id);
    // Title the bead with the agent's (default) name so beads stay distinguishable on the board
    // rather than a row of identical placeholders. Note: if the user removes the agent within the
    // sub-second `bd create` window, the bead is orphaned — an accepted best-effort tradeoff that
    // the Discard/prune flows mop up.
    const title =
      useProjectStore
        .getState()
        .projects.find((p) => p.id === proj.id)
        ?.agents.find((a) => a.id === id)?.name ?? "Build task";
    void createBeadFull(proj.rootPath, title, "", "task", "", "", "")
      .then((beadId) => setAgentBeadId(proj.id, id, beadId))
      .catch((e) => {
        // A project with no beads DB is a normal, supported state (bd is optional) — don't cry WARN
        // on every build-agent spawn for it; keep only genuine failures loud.
        if (isBeadsUnavailable(e)) {
          log.debug("build-agent", "auto-bead skipped: project has no beads database");
        } else {
          log.warn("build-agent", "auto-bead creation failed", e);
        }
      });
    return id;
  };
}
