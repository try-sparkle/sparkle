// "Land the user in this agent" — the ONE implementation of what every user-initiated agent
// hand-off owes the user: the thing you just asked for is what you are now looking at.
//
// WHY THIS EXISTS. §13 ("land the user in the new build agent's row") was implemented once, inline,
// in useSpawnBuildAgent — and the four other paths that hand a user to an agent each carried their
// own partial copy, so they drifted apart in exactly the ways you would predict:
//
//   • services/sendToBuild (Plan board "Start" / "Build It") called `open()` and NOTHING else. No
//     `selectAgent`, no `setActiveSpecial(null)`, no reveal. Clicking Build It on the board created
//     the orchestrator, seeded it, and left you staring at the board — `activeSpecial` was still
//     "board", so the right-hand pane never switched and the sidebar row never highlighted. Worse
//     on the REUSE path (one orchestrator per epic): with an existing agent `addAgent` is never
//     called at all, so not even its default `select: true` fired. The handoff was invisible.
//   • services/captureSends and components/selectionActions selected + opened but never revealed,
//     so in a long column the row they selected could sit below the fold.
//
// The four steps are not independently optional, which is the whole argument for one function:
//   1. Leave the Plan board AND the Improve-Sparkle pane. Selecting an agent while either is up
//      changes NOTHING on screen; whichever is up owns the pane. These are two separate pieces of
//      state now — the board is the target column's own `workMode`, not the window-global
//      `activeSpecial` — so this step has to clear BOTH or the board half silently stops working.
//   2. selectAgent            — decide which pane renders.
//   3. open                   — mount that pane / drive the PTY launch.
//   4. requestRevealAgent     — scroll the row on screen (AgentSidebar's AgentRow consumes it).
//
// NOT included, deliberately: `requestComposeFocus`. Taking the caret is a separate claim — its
// uiStore doc restricts it to "the user asking for the caret" — and only some of these callers have
// earned it (spawning an empty agent has; a board handoff that arrives with a seeded prompt has
// not). Call it at the call site when it applies.
//
// NOT for machine-created agents: services/workerSpawn (an orchestrator's MCP request) passes
// `select: false` precisely so a worker the user never asked for cannot take their terminal, and
// must not call this. Same for services/cloudAgents/reattach, which materializes tabs at startup.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { sideOf } from "../engine/pairs";
import { attentionHold, type AttentionHold } from "../engine/attentionGuard";

/** Did a PERSON ask for this hand-off, or did the app decide to make it? */
export type AttentionIntent =
  /** A click, a keystroke, a menu item. NEVER declined — the user asked, so they get moved. */
  | "user"
  /** The app moved on its own (a concierge spawn, a board hand-off, a captured send). Declined
   *  while the founder's attention is held — see engine/attentionGuard. */
  | "auto";

export interface LandInAgentOpts {
  /** Defaults to `"user"`, so every existing call site keeps today's behaviour verbatim. */
  attention?: AttentionIntent;
  /** The hold the caller ALREADY read, when it made earlier decisions off the same answer. Omitted
   *  means "read the live caret here". Passing it is how a multi-step caller avoids reading a moving
   *  value twice in one decision (see engine/attentionGuard's note); `null` is a real value meaning
   *  "I looked and nothing was held", and is not the same as omitting it. */
  hold?: AttentionHold | null;
}

/** What the hand-off actually did, so a caller reads an outcome instead of inferring one. */
export type LandOutcome =
  /** All four steps ran — the user is looking at the agent. */
  | "landed"
  /** The attention move was declined; the agent was still OPENED, so its pane mounts and its PTY
   *  launches. A held hand-off is quiet, never fictional. */
  | "held";

/**
 * Put `agentId` in front of the user: leave any special view, select it, open it, and scroll its
 * sidebar row into view. Call ONLY for a hand-off the user actually asked for.
 *
 * Callers pass an id they have already null-checked — every creator in this codebase can return
 * null (the project was closed in another window mid-action, roborev 46278), and revealing a
 * phantom id would scroll to a row that does not exist.
 *
 * ══ `attention: "auto"` MAY BE DECLINED ═════════════════════════════════════════════════════════
 * The founder's rule: a jump the app started must not take him out of a terminal he is typing in.
 * When it is declined, ONLY step 3 (`open`) runs — the one that mounts the pane and drives the PTY
 * launch. Dropping that too would not make the hand-off quiet, it would make it FICTIONAL: the agent
 * is created on paper, never starts, and every caller downstream reports success. That is the same
 * split `SpawnBuildAgentOpts.background` already draws, and for the same reason.
 */
export function landInAgent(
  projectId: string,
  agentId: string,
  opts: LandInAgentOpts = {},
): LandOutcome {
  if (opts.attention === "auto") {
    const hold = opts.hold !== undefined ? opts.hold : attentionHold();
    if (hold !== null) {
      useRuntimeStore.getState().open(agentId);
      return "held";
    }
  }
  const ui = useUiStore.getState();
  ui.setActiveSpecial(null);
  // The agent lives in exactly one column; that is the only board this hand-off may close.
  ui.setWorkMode(sideOf(ui.pairAssignment, projectId), "build");
  useProjectStore.getState().selectAgent(projectId, agentId);
  useRuntimeStore.getState().open(agentId);
  useUiStore.getState().requestRevealAgent(agentId);
  return "landed";
}
