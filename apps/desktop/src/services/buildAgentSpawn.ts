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
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { landInAgent } from "./landInAgent";
import { createBeadFull } from "./tasks";
import { isBeadsUnavailable, AUTO_LABEL } from "./beads";
import { localAgentCapacity } from "./agentCapacity";
import { attachBrief } from "./agentBrief";
import { markProjectVisited, wasProjectVisited } from "./sessionProjects";
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
  /**
   * A spawn THE HUMAN DID NOT INITIATE — an automatic sweep, a watchdog, a scheduled dispatch.
   * Defaults false, so every existing call site keeps today's "+ New Build Agent" behaviour.
   *
   * WHAT IT DROPS: only the things that move the user's attention — selecting the project on its
   * side, `landInAgent`'s select/reveal (leaving the Plan board, `selectAgent`, `requestRevealAgent`),
   * the row's default `select: true`, and the empty-spawn `requestComposeFocus`. `landInAgent`'s own
   * header already names this rule: a machine-created agent "must not call this", which is why
   * services/workerSpawn passes `select: false` and calls `runtime.open` directly instead.
   *
   * The reason is not politeness. Sparkle dispatches these on a timer (the `/babysit-pr` sweep fires
   * whenever a PR turns up carrying unanswered review probes, possibly several times an hour), and a
   * watchdog that yanks the founder's screen mid-task to an agent he never asked for is worse than
   * no watchdog.
   *
   * WHAT IT DOES **NOT** DROP, AND WHY THAT DISTINCTION IS LOAD-BEARING: the PANE MOUNT. `Workspace`
   * mounts a pane per project that is not torn out and is visited-or-current, times the agents in the
   * runtime OPEN set — per OPEN id, NOT per selection (Workspace.tsx's `live` memo). The pane mount
   * is what drives the PTY launch, and the opening brief is delivered as claude's positional argv AT
   * THAT LAUNCH (services/agentBrief). So skipping the mount would not make the spawn quiet, it would
   * make it FICTIONAL: the agent is created and briefed on paper, never starts, and every caller
   * downstream reports success. That is exactly the failure `attachBrief` and the "GUARANTEE A PANE
   * BEFORE PROMISING DELIVERY" note below exist to prevent. Background therefore still puts the new
   * id in the runtime OPEN set.
   *
   * IT SATISFIES THE PROJECT HALF OF THAT GATE BY REFUSING, NOT BY WRITING TO IT. Background does NOT
   * call `markProjectVisited`/`markProjectOpen`; it requires the project to be on screen ALREADY and
   * returns `null` otherwise. Marking it visited would have published that project and its prompt
   * snippets to the tray and the phone relay for the rest of the session — the visited set only ever
   * GROWS — which is the exact leak `services/sessionProjects` exists to close. See the refusal in
   * the body for the full reasoning (knightwatch #1251 probes 1 and 3).
   *
   * THREE REFUSALS APPLY, and a background caller must handle a null return like any other:
   *   • the machine-wide capacity ceiling, unchanged — a background dispatcher must never outrun
   *     the cap the human's own button respects;
   *   • a TORN-OUT project, which background refuses outright (see the guard below). This window
   *     cannot mount a pane for one at all, so the promise above is the one thing background
   *     cannot keep there;
   *   • a project THE HUMAN HAS NOT LOOKED AT this session. This is the most likely null a
   *     background dispatcher will see, so do not write null-handling that omits it: background may
   *     not mark a project visited to manufacture its own mount eligibility (that set is monotonic
   *     and feeds the roster publisher), so it requires the project to be on screen already.
   */
  background?: boolean;
}

/** Create + open a local Build agent in `project`, returning its id — or null when the spawn did not
 *  happen: the project is gone from the store (closed in another window between the caller's read
 *  and this call, roborev 46278), the machine is at its agent ceiling, or this is a BACKGROUND spawn
 *  into a torn-out project OR into one the human has not looked at this session. In every case
 *  NOTHING was created and no UI side-effect fired. */
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
  const background = opts.background === true;
  // A TORN-OUT PROJECT HAS NO PANE IN THIS WINDOW, so a background spawn into one is the exact
  // "created and briefed on paper, never starts" failure this mode's doc says it prevents
  // (roborev 58263). `Workspace`'s `live` memo `continue`s on `tornOut` BEFORE the visited check,
  // so nothing here can make main mount it; the satellite owns those panes and has its OWN module
  // instances, so it never sees this window's open-set write or its brief.
  //
  // The FOREGROUND path is deliberately left alone: it is already closed one level up (the human
  // cannot click "+ New Build Agent" for a project whose sidebar lives in another window, and
  // conciergeTools/lifecycle.spawnBuildAgent refuses with `project-torn-out` before reaching here).
  // A background dispatcher is the caller class with neither guard — an arbitrary projectId and no
  // human to notice the silence — so the refusal belongs in the shared implementation for it.
  //
  // Refused BEFORE `addAgent`, so an over-the-line request leaves the store exactly as it found it,
  // matching the capacity gate's contract above and this function's "NOTHING was created" promise.
  if (background && isTornOut(project.id)) {
    log.warn("build-agent", "background spawn refused: project is torn out into its own window", {
      projectId: project.id,
    });
    return null;
  }
  // AND A BACKGROUND SPAWN MAY NOT MANUFACTURE ITS OWN MOUNT ELIGIBILITY (knightwatch #1251 probe 1).
  //
  // `Workspace`'s `live` memo gates per PROJECT — `wasProjectVisited(p.id) || currentProjectId ||
  // leftProjectId` — and its comment is explicit that `openAgentIds` "never gets a say", deliberately
  // (roborev 55149: gating on the agent set instead produced zero mounted panes under a live tab).
  // So there are exactly two ways a pane can mount, and the honest one is the project already being
  // on screen; Workspace itself marks BOTH the current and the left project visited.
  //
  // The other way — calling `markProjectVisited` here — is the one this refusal replaces, because
  // that set is NOT ours to write. `services/sessionProjects` says it "only ever GROWS" within a
  // session and feeds TWO consumers: the pane mount AND the roster publisher. Its whole reason to
  // exist is stated in its own header: treating unvisited projects as open "leaked never-opened
  // projects (and their prompt snippets) into the tray and the phone relay". A background spawn that
  // marked a project visited would publish that project — and its prompt snippets — to the tray and
  // the phone for the REST OF THE SESSION, and because the set only grows, closing the agent would
  // never take it back. That is precisely the leak `sessionProjects` was written to close, re-opened
  // by a machine on a timer rather than by a human opening a tab.
  //
  // So refuse instead. A background dispatcher pointed at a project the human has not looked at gets
  // an explicit `null` and a logged reason, rather than a silent leak plus a pane that never mounts.
  // Refused BEFORE `addAgent`, like the two gates above, so nothing is created.
  if (background && !wasProjectVisited(project.id)) {
    log.warn("build-agent", "background spawn refused: project not on screen, so no pane would mount", {
      projectId: project.id,
    });
    return null;
  }
  const store = useProjectStore.getState();
  const id = store.addAgent(project.id, {
    kind: "build",
    // DON'T STEAL THE TAB (the same reasoning, and the same flag, as services/workerSpawn). Suppress
    // at the STORE rather than selecting-then-restoring, so there is no intermediate state a render
    // can observe and no phantom `switch:` perf waterfall from a selection that never painted.
    // `select: false` is ABSOLUTE — it will not backfill a null selection either (AddAgentOpts.select).
    ...(background ? { select: false as const } : {}),
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
  //
  // …unless `opts.background`, in which case everything below still runs EXCEPT the attention move —
  // see SpawnBuildAgentOpts.background. The paragraphs that follow are why the mount half is NOT
  // optional even then.
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
    //
    // ALL THREE OF THESE ARE FOREGROUND-ONLY (knightwatch #1251 probes 1 and 3). A background spawn
    // takes none of them, and needs none of them: the refusal above has already established that the
    // project is on screen, which is the whole of the mount gate. Each would otherwise be a visible
    // change to the human's window made on behalf of a spawn they never asked for —
    //   * `markProjectOpen` re-opens a tab the human deliberately CLOSED (probe 3),
    //   * `selectProjectOnItsSide` moves which project they are looking at,
    //   * `markProjectVisited` writes the human-only, monotonic visited set and thereby publishes the
    //     project and its prompt snippets to the tray and phone relay for the rest of the session
    //     (probe 1) — see the refusal above for why that set is not ours to write.
    if (!background) {
      markProjectOpen(project.id);
      // Side-aware (engine/pairs): "the thing you just asked for is what you are now looking at" only
      // holds if the selection lands in the pair that OWNS the project. For a left-assigned one, a
      // bare selectProject is reverted by the Workspace's reconcile effect and `leftProjectId` never
      // moves, so the freshly spawned agent lands off-screen (roborev 55158).
      selectProjectOnItsSide(project.id);
      // Visited is the OTHER half of the mount gate: a project selected but never marked is skipped
      // again as soon as the user navigates elsewhere.
      markProjectVisited(project.id);
    }
  }
  if (background) {
    // JUST STEP 3 OF `landInAgent` — `open`, the one that "mount[s] that pane / drive[s] the PTY
    // launch". Its other three steps (leave the special/board view, `selectAgent`,
    // `requestRevealAgent`) are precisely the attention move a spawn the human did not ask for has
    // not earned, and its header forbids machine-created agents from calling it at all. Calling
    // `runtime.open` directly is what services/workerSpawn already does for the same reason; this is
    // that precedent, not a second one.
    //
    // Dropping this instead would not make the spawn quiet — it would make it fictional. No pane ⇒
    // no launch ⇒ the brief's argv is never emitted, while everything downstream reports success.
    useRuntimeStore.getState().open(id);
  } else {
    landInAgent(project.id, id);
  }
  if (opts.prompt) {
    // ATTACH the brief for the LAUNCH ARGV — do NOT call `appendPrompt`, and no longer
    // `queuePendingSend` either.
    //
    // `appendPrompt` is pure bookkeeping: it moves `lastPrompt` and appends to `promptHistory`, and
    // writes nothing to the terminal. Seeding it directly would have been strictly WORSE than the
    // two-step it replaced (roborev 55057): the prompt would never reach claude, while
    // `engine/newAgentAttention.isBriefless` — which keys off exactly those two fields — would read
    // the row as briefed. Instead of a false red, the human would get a falsely CALM agent idling
    // at an empty prompt forever, with the pinned header confidently showing the brief that was
    // never sent.
    //
    // `queuePendingSend` was the previous answer, and it delivered the text but LOST THE SUBMIT on
    // five of five spawns: it writes into the PTY on `ptyReady`, which fires when `pty_spawn`
    // returns — before claude's TUI is reading stdin at all. The brief sat at the prompt with the
    // cursor after it until a human pressed Enter, while the reply said `briefed: true`. The full
    // measurement, and why an idle-output or fixed-delay heuristic cannot fix it, is in the header
    // of services/agentBrief.
    //
    // `attachBrief` hands it to the pane's launch instead, which emits it as claude's positional
    // prompt — the same mechanism worker agents have always used, and one claude submits itself at
    // startup. There is no paste, no carriage return, and so no window in which the submit can be
    // dropped. The prompt side-effects still happen on the delivery path, once (AgentPane), which is
    // what keeps the brief atomic *and* real.
    attachBrief(id, opts.prompt);
  } else if (!background) {
    // The caret is the half landInAgent deliberately leaves to the caller, and the EMPTY spawn has
    // earned it: the next thing the user does is type. A briefed spawn has not — sendToBuild skips
    // the focus request for exactly this reason, since taking the caret for a composer the user has
    // nothing to type into steals focus from whatever they were doing.
    //
    // Neither has a BACKGROUND spawn, for a stronger reason: nobody is about to type into it. The
    // uiStore doc restricts this seam to "the user asking for the caret", and an automatic sweep is
    // by definition not the user asking.
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
