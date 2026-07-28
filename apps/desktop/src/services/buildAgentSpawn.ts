// The ONE implementation of "start a local Build agent", extracted from hooks/useSpawnBuildAgent so
// non-React callers (the concierge's lifecycle tools — services/conciergeTools/lifecycle.ts) run the
// EXACT sequence the human's "+ New Build Agent" button runs, rather than a second copy of it that
// drifts. The hook is now a thin wrapper around this; every store touch goes through getState(), so
// the sequence is identical whether it is reached from a click or from a tool call.
//
// Creating the agent is synchronous (immediately usable) — the worktree + PTY are launched by the
// pane that mounts when `open(id)` lands it in the open set, which is why nothing here shells out.
// The bead is created async + best-effort and attached when `bd` returns: a build agent without a
// bead is still fine if bd is unavailable.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { createBeadFull } from "./tasks";
import { isBeadsUnavailable } from "./beads";
import { log } from "../logger";
import { perfStart } from "../perfTrace";
import type { Project } from "../types";

/** Create + open a local Build agent in `project`, returning its id — or null when the project is
 *  gone from the store (closed in another window between the caller's read and this call), in which
 *  case NOTHING was created and no UI side-effect fired (roborev 46278). */
export function spawnBuildAgentInProject(project: Project): string | null {
  const store = useProjectStore.getState();
  const id = store.addAgent(project.id, { kind: "build" });
  if (!id) return null;
  useUiStore.getState().setActiveSpecial(null); // creating an agent leaves the special (Sparkle/board) view
  // Start the spawn-latency waterfall the instant the agent is added — AgentPane.prepare() and
  // Terminal add the remaining milestones through to "pty ready" under the same key (perfTrace).
  perfStart(id, "spawn", { kind: "build" });
  useProjectStore.getState().selectAgent(project.id, id);
  useRuntimeStore.getState().open(id);
  // …and LAND the user in it (§13): scroll the new row into view and hand the caret to the one
  // compose surface (the concierge box). Both are one-shot request tokens the UI consumes.
  useUiStore.getState().requestRevealAgent(id);
  useUiStore.getState().requestComposeFocus();
  // Title the bead with the agent's (default) name so beads stay distinguishable on the board rather
  // than a row of identical placeholders. Best-effort: if the agent is removed within the sub-second
  // `bd create` window the bead is orphaned, which the Discard/prune flows mop up.
  const title =
    useProjectStore
      .getState()
      .projects.find((p) => p.id === project.id)
      ?.agents.find((a) => a.id === id)?.name ?? "Build task";
  void createBeadFull(project.rootPath, title, "", "task", "", "", "")
    .then((beadId) => useProjectStore.getState().setAgentBeadId(project.id, id, beadId))
    .catch((e) => {
      // A project with no beads DB is a normal, supported state (bd is optional) — don't cry WARN on
      // every build-agent spawn for it; keep only genuine failures loud.
      if (isBeadsUnavailable(e)) {
        log.debug("build-agent", "auto-bead skipped: project has no beads database");
      } else {
        log.warn("build-agent", "auto-bead creation failed", e);
      }
    });
  return id;
}
