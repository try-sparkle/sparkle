// What actually happens when a recommended-action button is clicked, shared by the two surfaces
// that show them: the AgentPane composer (Composer.tsx, still the host inside SparkleAgentPane)
// and the concierge column (ConciergeHost), which re-homed the row for build agents.
//
// WHY EXTRACTED, AND WHAT DELIBERATELY ISN'T. The three behaviours below are correctness-bearing
// and must not diverge between hosts:
//   • control-kind → an app action, never a PTY write, never gated on the terminal being alive
//   • terminal-kind → raw keystrokes PLUS the "picker" history entry (additive, never a
//     replacement) that the auto-naming ladder counts — without it a picker-driven agent sits at
//     promptCount 1 forever and is never named
//   • every non-control click records a learning event, which is what feeds the Haiku re-ranking
// What is NOT extracted is each host's own delivery of a prompt-kind button (`deliverPrompt`):
// the composer's path is attachment-aware and trial-gated its own way, the concierge's goes
// through dispatchConciergeAnswer's relay with its outcome reporting. Forcing those together
// would mean one host quietly inheriting the other's side effects, so the caller injects it.
// Composer's approval-nudge pre-step is likewise host-local — it renders into the composer.
import { writePty } from "../../pty";
import { closeBuildAgent } from "../closeBuildAgent";
import { getAgentScrollback } from "../terminalScrollback";
import { useProjectStore } from "../../stores/projectStore";
import { useSuggestionStore } from "../../stores/suggestionStore";
import { deriveContextTags } from "./contextTags";
import { parseControlAction, CLOSE_AGENT_ACTION } from "./controlButtons";
import type { SuggestionButton } from "./types";

export interface ApplySuggestionOptions {
  /** Deliver a prompt-kind button's text. Host-specific (see the file header).
   *
   *  Resolve FALSE to veto — the host declined to send (trial spent, no entitlement). A veto must
   *  not record a learning event and must not clear the row: the click did nothing, so teaching
   *  the re-ranker from it would poison the history with actions the user never actually took,
   *  and clearing would take away the button they were trying to press. Anything else (including
   *  undefined) counts as delivered. */
  deliverPrompt: (text: string) => Promise<boolean | void> | boolean | void;
  /** Host veto for PTY-touching kinds — the composer's "terminal isn't spawned" gate. Control-kind
   *  buttons ignore this by design: they touch nothing in the PTY. */
  disabled?: boolean;
  /** Runs just before a terminal-kind keystroke lands, while the screen still shows the prompt
   *  that produced it (the composer's auto-approve nudge hooks in here). */
  beforeTerminalWrite?: (b: SuggestionButton) => void;
}

/** Record the answer as a "picker" prompt turn — additive to the PTY write, never a replacement.
 *  Stays out of every DISPLAY surface (composerPrompts filters it) but advances
 *  promptHistory.length, which is the promptCount the naming ladder reads. Stores the readable
 *  LABEL, not the bare "1\n" keystroke. No-op when the agent's project has been unloaded. */
function recordPickerTurn(agentId: string, label: string): void {
  const projectId = useProjectStore
    .getState()
    .projects.find((p) => p.agents.some((a) => a.id === agentId))?.id;
  if (projectId) useProjectStore.getState().appendPrompt(projectId, agentId, label, "picker");
}

/**
 * Run a clicked suggestion. Returns TRUE when the click did something (so the host can clear its
 * row) and FALSE when it was vetoed by `disabled` — a no-op click must not clear the row, or the
 * user loses the button they were trying to press.
 */
export async function applySuggestion(
  agentId: string,
  b: SuggestionButton,
  opts: ApplySuggestionOptions,
): Promise<boolean> {
  if (b.kind === "control") {
    // Not a learnable "action" and not PTY-gated. Routed by action id.
    if (parseControlAction(b.value) === CLOSE_AGENT_ACTION) await closeBuildAgent(agentId);
    return true;
  }
  if (opts.disabled) return false;

  if (b.kind === "terminal") {
    // Terminal-kind buttons come ONLY from the local heuristic detector and carry a bare control
    // keystroke (y/n, a menu digit) — interactive terminal input, not a metered "send" — so they
    // intentionally bypass the trial-cap gate, exactly like typing into the terminal directly.
    opts.beforeTerminalWrite?.(b);
    await writePty(agentId, b.value);
    recordPickerTurn(agentId, b.label);
  } else if ((await opts.deliverPrompt(b.value)) === false) {
    return false; // host vetoed — nothing happened, so record nothing and clear nothing
  }

  useSuggestionStore.getState().recordEvent({
    contextTags: deriveContextTags(getAgentScrollback(agentId) ?? ""),
    label: b.label,
    value: b.value,
    kind: b.kind,
  });
  return true;
}
