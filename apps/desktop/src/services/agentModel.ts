// Mid-session model change (bead sparkle-i6rw): deliver a newly picked Claude model to an agent
// that is ALREADY running, by typing the interactive REPL's `/model <id>` slash command into its
// live PTY — no respawn, the conversation continues on the new model. The store update
// (projectStore.setAgentModel) is separate and always happens; this is only the live delivery.
import { writePty } from "../pty";
import { useRuntimeStore } from "../stores/runtimeStore";
import { isDefaultModel } from "./models";

/** Delay between typing the slash command and sending Enter. Claude Code's TUI pops a
 *  slash-command autocomplete while the input starts with "/" — submitting in the same write
 *  risks the popup swallowing the Enter (or completing over the typed args). Typing first and
 *  submitting in a SECOND write after a beat lets the TUI settle on the fully-typed command.
 *  Deliberately longer than submitPrompt's 60ms paste-ingest beat, for the popup. */
export const MODEL_SUBMIT_DELAY_MS = 200;

// Ctrl-E (end-of-line) + Ctrl-U (kill before cursor): clear the REPL's input line. The user may
// have half-typed a prompt in the terminal when they pick a model; slash commands are only
// recognized on an otherwise-empty line, so without this the write would submit
// "<half-typed text>/model <id>" as a garbled PROMPT (roborev 23524). Ctrl-U alone only kills
// text BEFORE the cursor — Ctrl-E first makes it a whole-line clear even with the cursor
// mid-line (roborev 23540). Both are no-ops on an empty line. Known accepted residual: a
// MULTI-LINE draft (pasted block) only has its current line cleared — earlier lines survive
// and would still garble the command (roborev 23548/23549).
const CLEAR_LINE = "\x05\x15";

// Per-agent delivery chain: two picks inside the MODEL_SUBMIT_DELAY_MS window would otherwise
// interleave their writes ("/model a" "/model b" "\r" "\r" → the junk line "/model a/model b").
// Chaining serializes them — both apply in order, the last pick wins (roborev 23524).
const deliveryChain = new Map<string, Promise<void>>();

/** Is it safe to inject keystrokes into this agent's PTY right now? Best-effort, keyed off the
 *  LAST-KNOWN hook-driven status (which can lag the actual screen by a beat): skip while the
 *  REPL is showing a live question (permission/approval menu, "needs you" prompt) — keystrokes
 *  would land on THAT dialog and the trailing Enter could confirm an action the user never
 *  approved (roborev 23525). The store already holds the new model, so skipping just means it
 *  applies on the next spawn instead. Deliberately allowed: `working` (Claude Code buffers
 *  typed input into the composer while generating), `errored` (a stalled REPL still sits at a
 *  normal prompt — /model is useful there and there's no dialog to mis-confirm; that's why this
 *  is NOT engine/attention's needsAttention set), and `undefined` (a just-spawned idle agent
 *  has no status yet, and a model picked right after spawn must still deliver — the feature's
 *  core case). */
function canInject(agentId: string): boolean {
  const s = useRuntimeStore.getState();
  if (!s.isOpen(agentId)) return false;
  const st = s.status[agentId];
  return st !== "waiting" && st !== "approval";
}

async function deliver(agentId: string, modelId: string): Promise<void> {
  // Liveness + modal state are checked at DELIVERY time (after any queued predecessor), not at
  // call time.
  if (!canInject(agentId)) return;
  await writePty(agentId, `${CLEAR_LINE}/model ${modelId}`);
  await new Promise((r) => setTimeout(r, MODEL_SUBMIT_DELAY_MS));
  // Re-check before the hazardous keystroke: a working agent can pop a permission prompt
  // DURING the submit delay (roborev 23548/23549). Skipping the Enter leaves benign text in
  // the composer — strictly safer than confirming a dialog the user never approved.
  if (!canInject(agentId)) return;
  await writePty(agentId, "\r");
}

/**
 * Type `/model <id>` + Enter into the agent's live PTY, if it has one (PTY ids are agent ids;
 * runtimeStore.openAgentIds tracks the panes with a spawned PTY). Selecting the "default"
 * sentinel writes nothing — Claude Code has no "unset" argument for /model, so the sentinel
 * only affects the NEXT spawn (no --model flag). Fire-and-forget safe: PTY errors are
 * swallowed (logged), never surfaced — the store already holds the new model for the next
 * spawn either way.
 */
export function applyModelToRunningAgent(agentId: string, modelId: string): Promise<void> {
  if (isDefaultModel(modelId)) return Promise.resolve();
  const next = (deliveryChain.get(agentId) ?? Promise.resolve())
    .then(() => deliver(agentId, modelId))
    // warn, not debug: writePty already swallows the expected "pty exited" teardown race, so
    // anything landing here is an UNEXPECTED failure that shouldn't be console-filtered away.
    .catch((e) => console.warn("applyModelToRunningAgent failed for", agentId, e));
  deliveryChain.set(agentId, next);
  // Drop the map entry once the chain drains, so it can't grow over a long session.
  void next.then(() => {
    if (deliveryChain.get(agentId) === next) deliveryChain.delete(agentId);
  });
  return next;
}
