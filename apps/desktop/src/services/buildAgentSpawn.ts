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
import { useUiStore } from "../stores/uiStore";
import { landInAgent } from "./landInAgent";
import { createBeadFull } from "./tasks";
import { isBeadsUnavailable, AUTO_LABEL } from "./beads";
import { localAgentCapacity } from "./agentCapacity";
import { log } from "../logger";
import { perfStart } from "../perfTrace";
import type { Project } from "../types";

/** Create + open a local Build agent in `project`, returning its id — or null when the spawn did not
 *  happen: the project is gone from the store (closed in another window between the caller's read
 *  and this call, roborev 46278), or the machine is at its agent ceiling. Either way NOTHING was
 *  created and no UI side-effect fired. */
export function spawnBuildAgentInProject(project: Project): string | null {
  // THE machine-wide gate, and it lives HERE — in the one shared implementation — rather than in
  // each caller. It used to sit only in the concierge's `spawn_build_agent`, so the concierge was
  // refused at capacity while the human's "+ New Build Agent" button called straight through and
  // kept going: one project was observed growing 4 → 15 agents while the machine-wide count was
  // already over the ceiling. A cap enforced on one of two paths is not a cap.
  //
  // Checked BEFORE anything is created, so an over-cap request leaves the store exactly as it found
  // it. Refused, never queued: a silent queue would leave a human waiting on an agent with no slot
  // and no ETA. The concierge checks first too — not redundantly, but so it can REFUSE WITH A
  // REASON; reaching this line means a path that has no channel for one, so it logs and declines.
  const capacity = localAgentCapacity();
  if (capacity.atCapacity) {
    log.warn("build-agent", "spawn refused: at machine agent capacity", {
      used: capacity.used,
      limit: capacity.limit,
      basis: capacity.basis,
    });
    return null;
  }
  const store = useProjectStore.getState();
  const id = store.addAgent(project.id, { kind: "build" });
  if (!id) return null;
  // Start the spawn-latency waterfall the instant the agent is added — AgentPane.prepare() and
  // Terminal add the remaining milestones through to "pty ready" under the same key (perfTrace).
  perfStart(id, "spawn", { kind: "build" });
  // LAND the user in it (§13): leave the special (Sparkle/board) view, select, open, and scroll the
  // new row into view. Those four steps were written out here, which is how the OTHER hand-off
  // paths ended up with partial copies — services/sendToBuild called `open()` alone, so clicking
  // "Start"/"Build It" on the Plan board left the user on the board with nothing visibly changed.
  // They live in services/landInAgent now, one implementation for every path.
  landInAgent(project.id, id);
  // The caret is the half landInAgent deliberately leaves to the caller, and this path has earned
  // it: the agent arrives EMPTY, so the next thing the user does is type. sendToBuild has NOT —
  // it arrives with a seeded prompt — which is exactly why this is not folded into the helper.
  useUiStore.getState().requestComposeFocus();
  // Title the bead with the agent's (default) name so beads stay distinguishable on the board rather
  // than a row of identical placeholders. Best-effort: if the agent is removed within the sub-second
  // `bd create` window the bead is orphaned, which the Discard/prune flows mop up.
  const title =
    useProjectStore
      .getState()
      .projects.find((p) => p.id === project.id)
      ?.agents.find((a) => a.id === id)?.name ?? "Build task";
  // Labeled `sparkle-auto` so the board can tell app-generated telemetry from beads a human filed —
  // see AUTO_LABEL. Without it these are indistinguishable from real backlog once the agent is gone.
  void createBeadFull(project.rootPath, title, "", "task", "", "", AUTO_LABEL)
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
