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
import { attentionHold } from "../engine/attentionGuard";
import { createBeadFull } from "./tasks";
import { isBeadsUnavailable, AUTO_LABEL } from "./beads";
import { localAgentCapacity } from "./agentCapacity";
import { attachBrief, clearBrief } from "./agentBrief";
import { markProjectVisited, wasProjectVisited } from "./sessionProjects";
import { markProjectOpen } from "./projectTabs";
import { isTornOut } from "./satelliteWindows";
import { log } from "../logger";
import { perfStart, perfCancel } from "../perfTrace";
import { removeAgentWithoutPane } from "./agentTeardown";
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
  /**
   * Did a PERSON make this gesture? Defaults to `"user"`, which is NEVER declined.
   *
   * ── WHY THE DEFAULT MUST BE `"user"`, NOT THE OTHER WAY ROUND ────────────────────────────────
   * This function is the body of three DIRECT human gestures (`hooks/useSpawnBuildAgent`: the
   * sidebar's "+ New Build Agent" row, the Workspace empty-state start button, and
   * `useNewBuildAgentDrop`) as well as of the concierge's `spawn_build_agent` tool. Reading the
   * attention hold for all of them was the first cut of this guard and it was wrong — the whole
   * safety argument for `engine/attentionGuard` is that it declines only jumps the APP starts, and
   * an earlier, wider terminal-focus veto had to be reverted precisely because it declined things
   * the user had just asked for (services/terminalMidCommand's header).
   *
   * The DROP flow is the concrete failure that default prevents: a native Tauri drag/drop moves no
   * DOM focus, so with the caret in a terminal — the steady state in a terminal-first shell — a drop
   * on "+ New Build Agent" would create the agent off-screen, never select it, and skip the caret
   * pull, while `useNewBuildAgentDrop` queues the dropped paths for "the new agent's composer to
   * drain once it mounts", which never becomes the aim. The files would silently go nowhere.
   *
   * So `"auto"` is opt-IN, and today exactly one caller passes it: the concierge's lifecycle tool,
   * which is the machine acting on the founder's behalf rather than his own hand on a control.
   * `background` is the stronger, separate statement that nobody asked at all.
   */
  attention?: "user" | "auto";
}

/** Create + open a local Build agent in `project`, returning its id — or null when the spawn did not
 *  happen: the project is gone from the store (closed in another window between the caller's read
 *  and this call, roborev 46278), the machine is at its agent ceiling, this is a BACKGROUND spawn
 *  into a torn-out project OR into one the human has not looked at this session, or a step between
 *  `addAgent` and the brief THREW and the row was torn back down (see the fence in the body).
 *
 *  IN EVERY CASE NO AGENT EXISTS — that is the guarantee callers may rely on, and the teardown
 *  restores it by removing the row, clearing the brief, and closing the persisted open-set entry.
 *
 *  IT IS NOT "no side-effect fired", and the difference matters to anything that narrates a null to
 *  a human. The four pre-checks refuse before touching anything, but on the FOREGROUND path the
 *  teardown runs after `markProjectOpen`/`selectProjectOnItsSide`/`markProjectVisited` have already
 *  fired — so a tab the human closed may have reopened, the selection may have moved, and the
 *  project is in the monotonic visited set for the rest of the session. Those three are genuinely
 *  irreversible; everything the teardown CAN undo (the row, the brief, the persisted open entry, the
 *  perf trace) it does. Say "no agent was created", not "nothing happened". */
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
  // ══ IS THE FOUNDER TYPING SOMEWHERE RIGHT NOW? ════════════════════════════════════════════════
  // Read ONCE, here, and threaded through every decision below. Three separate steps turn on this
  // answer (`select: false`, the project switch, and the landing), and re-reading the live caret at
  // each of them is how a guard ends up describing one element and acting on another — the caret
  // moves, and `addAgent` is itself capable of moving it. See engine/attentionGuard.
  //
  // ONLY an `attention: "auto"` caller may be declined — see the field's own doc for why the
  // default is `"user"` and what breaks when it is not. A BACKGROUND spawn does not need to ask
  // either: it already suppresses everything this could, so the read would be pure cost on a path
  // that runs on a timer.
  const hold = background || opts.attention !== "auto" ? null : attentionHold();
  if (hold) {
    log.info("build-agent", "spawn will not take the view: the founder's attention is held", {
      projectId: project.id,
      hold,
    });
  }
  // "QUIET" IS THE UNION, AND IT IS NOT THE SAME AS `background`. Background additionally REFUSES a
  // project that is not on screen and declines to write the visited/open sets, because nobody asked
  // for it. This spawn WAS asked for — the founder told the concierge to start it — so it keeps every
  // one of those, and drops only the steps that move his eyes.
  const quiet = background || hold !== null;
  // The caret is a SEPARATE grant from the view, even though today they are decided together: the
  // empty-spawn path below pulls the caret into the concierge composer, which is the loudest form of
  // the steal (it moves the keyboard out of his terminal with no pane change to even hint at why).
  // Named here rather than written inline at its `if` so the decision is one readable statement and
  // so a mutation aimed at it can be judged (a bare `if (!quiet) {` cannot be mutated without
  // breaking the parse, which leaves the site unverified).
  const mayTakeCaret = !quiet;
  const store = useProjectStore.getState();
  const id = store.addAgent(project.id, {
    kind: "build",
    // DON'T STEAL THE TAB (the same reasoning, and the same flag, as services/workerSpawn). Suppress
    // at the STORE rather than selecting-then-restoring, so there is no intermediate state a render
    // can observe and no phantom `switch:` perf waterfall from a selection that never painted.
    // `select: false` is ABSOLUTE — it will not backfill a null selection either (AddAgentOpts.select).
    ...(quiet ? { select: false as const } : {}),
    // Both are already first-class AddAgentOpts fields, so naming and model selection need no new
    // persistence — they are simply settled here instead of by a follow-up call.
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    // Only "plan" is persisted — "build" is the ordinary mode and is represented by storing
    // nothing, so asking for build never overrides the user's own permission default.
    ...(opts.mode === "plan" ? { permissionMode: "plan" as const } : {}),
  });
  if (!id) return null;
  // "A NULL OR A THROW MEANS NOTHING WAS CREATED" — HELD BY CONSTRUCTION, NOT BY ASSERTION
  // (roborev 59548 then 59562).
  //
  // Every refusal above returns `null` BEFORE `addAgent`, which is what lets a caller read a
  // non-answer as "the store is as I found it". Past this line the row exists, so that has to be
  // re-established rather than claimed. `babysitDispatcher.dispatchOne` is the caller that makes it
  // load-bearing: the synthetic lease is the ONLY exclusion for that PR, and it releases on a
  // null-or-throw. Get this wrong in either direction and the damage is published to a human's PR —
  // release when an agent DOES exist and the next sweep adds a SECOND driver; return a truthy id
  // when the agent will never start and the lease is held for 90 minutes while nothing is watching.
  //
  // So the split below is BY CONSEQUENCE, not by position:
  //   * Before the brief is attached, nothing is running yet. A throw there tears the row back down
  //     and returns `null` — the contract holds because the agent really is gone, the capacity slot
  //     is freed, and the caller's ordinary refusal path does the right thing with no special case.
  //   * After it, the agent is live and briefed and claude is launching. A throw in the cosmetic
  //     tail must NOT unmake that, so it is logged and the id is returned.
  let launched = false;
  try {
    // Telemetry only, and deliberately inside the fence: if the waterfall cannot start, that is not
    // a reason to refuse a spawn, but tearing down below is still the safe direction.
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
        //
        // THE ONE STEP A HELD SPAWN DROPS FROM THIS BLOCK, and it is dropped because it is the only
        // one the founder can SEE: it changes which project his window is showing, which is the
        // coarsest version of the yank he asked us to stop. Its two neighbours stay, deliberately —
        // they are what makes the spawn real rather than fictional, and neither moves his eyes:
        //   * `markProjectOpen` adds a tab to the strip; the pane he is typing in is untouched.
        //   * `markProjectVisited` is half of Workspace's mount gate, and the mount is what launches
        //     the PTY. Background must not write it (nobody asked, and the set leaks to the tray for
        //     the rest of the session — knightwatch #1251 probe 1); a held spawn WAS asked for by the
        //     founder, into a project he owns, so the leak argument does not apply.
        if (!quiet) selectProjectOnItsSide(project.id);
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
      // `hold` is passed rather than re-read: this is the SAME decision `quiet` was computed from a
      // few lines up, and letting `landInAgent` take its own reading would let the two disagree.
      // When it is held, `landInAgent` degrades to exactly the `open(id)` above — see its header.
      landInAgent(project.id, id, { attention: "auto", hold });
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
      // THE RECORD IS AUTHORSHIP, NOT BOOKKEEPING, ON THIS PATH — and only `background` can say it.
      // A foreground spawn's brief is a send the human asked for (the "+ New Build Agent" body, or a
      // concierge spawn the user just requested), and `send_to_agent_terminal` already establishes
      // that LLM-composed prose dispatched on a person's behalf BILLS. So it attaches no record and
      // the delivery path does all five writes, exactly as before.
      //
      // A BACKGROUND spawn is the one class where that is false, and this interface already defines
      // it that way: "A spawn THE HUMAN DID NOT INITIATE — an automatic sweep, a watchdog, a
      // scheduled dispatch." Its only caller today is the `/babysit-pr` dispatcher, which fires on a
      // TIMER, possibly several times an hour per watched PR, with nobody watching. Left unmarked,
      // each of those debited a free-trial prompt for a send nobody made and taught the ghost-text
      // corpus a generated babysit brief — the corpus whose own doc reserves it for what a person
      // actually TYPED. `conciergeDispatch.recordPromptSideEffects` keys those effects on the
      // record's presence, so declaring one here is what suppresses them.
      //
      // No `promptId`: nothing was written to the store, so the delivery path must still APPEND the
      // row. That half is keyed on the id, not on the record — see the two-axis note there.
      //
      // AUTO-NAMING IS SUPPRESSED TOO, AND THAT IS DECIDED, NOT INCIDENTAL: the only background
      // caller passes an explicit `name` (`Babysit #<pr>`), so there is nothing for the naming model
      // to add — and asking it to summarize a generated brief would spend a paid call to rename a
      // row that is already named. A future background caller that wants a generated name should
      // pass `name` rather than relying on the ladder.
      attachBrief(id, opts.prompt, background ? { humanAuthored: false } : undefined);
      // PAST THE POINT OF NO RETURN: the pane is mounted and the brief will be claude's argv. From
      // here a failure is the caller's to hear about, not a reason to unmake a running agent.
      launched = true;
    } else {
      // An empty spawn has no brief to attach, so its pane mounting IS its launch — for the
      // background flavour too, which takes neither branch below.
      launched = true;
      // `mayTakeCaret` (i.e. `!quiet`), NOT `!background`: taking the caret is the very thing a held
      // spawn must not do — see where it is computed.
      if (mayTakeCaret) {
        // The caret is the half landInAgent deliberately leaves to the caller, and the EMPTY spawn
        // has earned it: the next thing the user does is type. A briefed spawn has not — sendToBuild
        // skips the focus request for exactly this reason, since taking the caret for a composer the
        // user has nothing to type into steals focus from whatever they were doing.
        //
        // Neither has a BACKGROUND spawn, for a stronger reason: nobody is about to type into it. The
        // uiStore doc restricts this seam to "the user asking for the caret", and an automatic sweep
        // is by definition not the user asking.
        useUiStore.getState().requestComposeFocus();
      }
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
  } catch (e) {
    if (!launched) {
      // NOTHING IS RUNNING YET, so make that true of the store as well and refuse. Returning a
      // truthy id here would be the worst of the three outcomes: `dispatchOne` would log
      // "dispatched a driver", hold the lease for its full 90-minute stale window, and never retry —
      // while the row sits mounted-but-briefless, holding a machine-wide capacity slot that nothing
      // can even flag as needing attention, because nothing ever briefed it.
      log.warn("build-agent", "spawn failed before launch; tearing the row back down", {
        id,
        error: String(e),
      });
      clearBrief(id, "spawn failed before launch");
      // The trace `perfStart` opened can only be removed by `perfEnd`/`perfCancel`, and neither can
      // ever fire for a row being torn down — the pane that would call them is never going to exist.
      // Left behind it is not cosmetic: `openTraceKinds()` is the jank monitor's only attribution
      // channel on macOS WKWebView and reports every entry still in the map, so each failed spawn
      // would add a permanent phantom in-flight `spawn` and misattribute every later stall in the
      // session. `perfCancel` exists for exactly this ("teardown before completion").
      perfCancel(id);
      // `open(id)` writes the id into the PERSISTED open set, so removing the row alone would leave
      // it in localStorage until something happened to run the reconcile prune. Closed first,
      // because after `removeAgent` there is no row for a reconcile to match it against.
      useRuntimeStore.getState().close(id);
      // A FAILED SPAWN IS NOT A CLOSE. `open(id)`/`landInAgent` really did run above, but the whole
      // `try` body is await-free so this `catch` is the SAME TICK and React never rendered — no pane
      // mounted, the store opens no `close:` trace, and this is a no-op. It stays as the explicit
      // statement of intent: should a pane ever exist here, timing its unmount as a "close" would
      // report an interaction the user never performed. See `removeAgentWithoutPane`.
      removeAgentWithoutPane(project.id, id);
      return null;
    }
    // The agent is live and briefed; only the cosmetic tail failed. Unmaking it would be worse.
    log.warn("build-agent", "post-launch setup failed; the agent is running", {
      id,
      error: String(e),
    });
  }
  return id;
}
