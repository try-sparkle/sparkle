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
import { selectProjectOnItsSide } from "./openProjectTab";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { landInAgent } from "./landInAgent";
import { createBeadFull } from "./tasks";
import { isBeadsUnavailable, AUTO_LABEL } from "./beads";
import { localAgentCapacity } from "./agentCapacity";
import { queuePendingSend } from "./pendingSends";
import { markProjectVisited } from "./sessionProjects";
import { markProjectOpen } from "./projectTabs";
import { isTornOut } from "./satelliteWindows";
import { log } from "../logger";
import { perfStart } from "../perfTrace";
import type { Project } from "../types";

/**
 * What a caller may settle AT SPAWN, rather than in a second call afterwards.
 *
 * The whole point is atomicity. Spawning blank and then briefing is two operations with a window
 * between them, and in that window the agent is a briefless row — which is exactly the state the
 * attention engine reads as "needs you" and renders red. The concierge's only route used to be that
 * two-step, so the workaround for a missing feature manufactured a false notification every time.
 * Everything here is applied before the pane mounts, so no such window exists.
 */
export interface SpawnBuildAgentOpts {
  /** The agent's opening brief, queued as its first prompt. Omitted → an empty agent (the "+ New
   *  Build Agent" button's behaviour), which is a deliberate state and NOT an attention condition. */
  prompt?: string;
  /** Human-readable name, set now instead of leaving the row as "Build N" until auto-naming
   *  catches up. */
  name?: string;
  /** A services/models.ts id, or "default" to inherit the user's own Claude Code setting. */
  model?: string;
  /** "plan" starts the agent researching-before-editing; "build" is the ordinary mode and is
   *  represented by the ABSENCE of a flag (see ClaudeExecOpts.permissionMode). */
  mode?: "plan" | "build";
}

/** Create + open a local Build agent in `project`, returning its id — or null when the spawn did not
 *  happen: the project is gone from the store (closed in another window between the caller's read
 *  and this call, roborev 46278), or the machine is at its agent ceiling. Either way NOTHING was
 *  created and no UI side-effect fired. */
export function spawnBuildAgentInProject(
  project: Project,
  opts: SpawnBuildAgentOpts = {},
): string | null {
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
  const id = store.addAgent(project.id, {
    kind: "build",
    // Both are already first-class AddAgentOpts fields, so naming and model selection need no new
    // persistence — they are simply settled here instead of by a follow-up call.
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    // Only "plan" is persisted — "build" is the ordinary mode and is represented by storing
    // nothing, so asking for build never overrides the user's own permission default.
    ...(opts.mode === "plan" ? { permissionMode: "plan" as const } : {}),
  });
  if (!id) return null;
  // Start the spawn-latency waterfall the instant the agent is added — AgentPane.prepare() and
  // Terminal add the remaining milestones through to "pty ready" under the same key (perfTrace).
  perfStart(id, "spawn", { kind: "build" });
  // LAND the user in it (§13): leave the special (Sparkle/board) view, select, open, and scroll the
  // new row into view. Those four steps were written out here, which is how the OTHER hand-off
  // paths ended up with partial copies — services/sendToBuild called `open()` alone, so clicking
  // "Start"/"Build It" on the Plan board left the user on the board with nothing visibly changed.
  // They live in services/landInAgent now, one implementation for every path.
  // GUARANTEE A PANE BEFORE PROMISING DELIVERY (roborev 55088).
  //
  // `landInAgent` selects the AGENT but never the PROJECT — `selectAgent` writes only that project's
  // own `selectedAgentId`. Workspace mounts panes solely for projects that are visited-or-current,
  // so a spawn into a project the user has not opened this session mounts nothing, and a queued
  // brief has no `flushPendingSends` to drain it: the queue does not self-age, so the entry would sit
  // forever with no delivery AND no expiry outcome, while the reply claimed `briefed: true`.
  //
  // `spawn_build_agent` takes an arbitrary `projectId`, so that is a reachable call, not a corner.
  // Switching the window is also what `landInAgent` already promises ("the thing you just asked for
  // is what you are now looking at") — it simply could not deliver it from inside that helper.
  // A TORN-OUT project is left alone entirely. `Workspace.tsx` bails on `tornOut.has(p.id)` BEFORE
  // the visited-or-current check, so main mounts nothing for it no matter what we select — and
  // selecting it would navigate main onto the re-dock placeholder, away from the user's work, to a
  // view that renders no agents. The satellite window owns that project's panes. Callers that need
  // delivery must refuse before reaching here (see lifecycle.spawnBuildAgent's `project-torn-out`),
  // because the satellite has its OWN pendingSends module instance and cannot see this queue.
  if (!isTornOut(project.id)) {
    // `markProjectOpen` BEFORE `selectProject`, never bare. The two are paired at every other seam
    // (openProjectTab, useReplaceCurrentProject, agentReveal.selectAndOpen) for a reason spelled out
    // in agentReveal's header: selecting a project whose tab is closed leaves the strip with no tab
    // for it and every tab reading aria-selected="false" — and it self-heals the WRONG way, since
    // the next tab close treats a selection with no tab as stale and yanks the user elsewhere
    // (engine/openProjects.selectionAfterClose). A bare selectProject here was a fourth seam
    // reintroducing exactly that (roborev 55095).
    markProjectOpen(project.id);
    // Side-aware (engine/pairs): "the thing you just asked for is what you are now looking at" only
    // holds if the selection lands in the pair that OWNS the project. For a left-assigned one, a bare
    // selectProject is reverted by the Workspace's reconcile effect and `leftProjectId` never moves,
    // so the freshly spawned agent lands off-screen (roborev 55158).
    selectProjectOnItsSide(project.id);
    // Visited is the OTHER half of the mount gate: a project selected but never marked is skipped
    // again as soon as the user navigates elsewhere.
    markProjectVisited(project.id);
  }
  landInAgent(project.id, id);
  if (opts.prompt) {
    // QUEUE the brief for the PTY — do NOT call `appendPrompt` here.
    //
    // `appendPrompt` is pure bookkeeping: it moves `lastPrompt` and appends to `promptHistory`, and
    // writes nothing to the terminal. Seeding it directly would have been strictly WORSE than the
    // two-step it replaced (roborev 55057): the prompt would never reach claude, while
    // `engine/newAgentAttention.isBriefless` — which keys off exactly those two fields — would read
    // the row as briefed. Instead of a false red, the human would get a falsely CALM agent idling
    // at an empty prompt forever, with the pinned header confidently showing the brief that was
    // never sent.
    //
    // `queuePendingSend` is the buffer built for precisely this window ("the seconds between spawn
    // and first prompt"): AgentPane drains it via `flushPendingSends` on ptyReady, which calls
    // `submitPrompt` AND `recordPromptSideEffects` — so the store update happens there, once, on
    // the delivery path. That is what makes the brief atomic *and* real.
    // `humanAuthored: true` — and the honest reason is that it cannot matter here, not that the
    // brief is always typed by a person. It is NOT: the concierge's `spawn_build_agent` lifecycle
    // tool passes a `prompt` its own model may have composed. What the flag governs is
    // `projectStore.releaseGoalDebt`, and this send lands on an agent created microseconds ago —
    // no goal, no `goalDebt`, and (since roborev 55588) a freshly-set clean goal is left
    // reference-identical too. There is no debt for either answer to release.
    //
    // Stated rather than left implicit because it stops being true the moment spawn seeds an agent
    // that INHERITS a goal or a debt (a reused id, a restored session). If that ever lands, thread
    // the real `isHumanAuthored(authority)` down from the spawn caller instead of re-reading this
    // comment as a licence.
    queuePendingSend({ agentId: id, text: opts.prompt, userPrompt: true, humanAuthored: true });
  } else {
    // The caret is the half landInAgent deliberately leaves to the caller, and the EMPTY spawn has
    // earned it: the next thing the user does is type. A briefed spawn has not — sendToBuild skips
    // the focus request for exactly this reason, since taking the caret for a composer the user has
    // nothing to type into steals focus from whatever they were doing.
    useUiStore.getState().requestComposeFocus();
  }
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
