// Spawn a Build agent from anywhere in the UI (the sidebar's "+ New Build Agent" row AND the
// empty-state start button on the Workspace share this one implementation). Creating the agent is
// synchronous (immediately usable); a bead is created async + best-effort and attached when `bd`
// returns — a build agent without a bead is still fine if bd is unavailable. Leaving the special
// (Sparkle/board) view is part of "start a build agent", so it's folded in here too.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { createBeadFull } from "../services/tasks";
import type { Project } from "../types";

export function useSpawnBuildAgent(project: Project | null): () => void {
  const addAgent = useProjectStore((s) => s.addAgent);
  const selectAgent = useProjectStore((s) => s.selectAgent);
  const setAgentBeadId = useProjectStore((s) => s.setAgentBeadId);
  const open = useRuntimeStore((s) => s.open);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);
  return () => {
    if (!project) return;
    const proj = project;
    setActiveSpecial(null); // creating an agent leaves the special (Sparkle/board) view
    const id = addAgent(proj.id, { kind: "build" });
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
      .catch((e) => console.warn("auto-bead creation failed (bd unavailable?):", e));
  };
}
