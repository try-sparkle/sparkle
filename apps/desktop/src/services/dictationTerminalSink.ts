// DELIVER A SPOKEN PHRASE INTO THE TERMINAL THE USER IS LOOKING AT.
//
// The effectful half of `voice/dictationTerminalRoute` — that module decides, this one reads the
// live DOM/registries and performs the write. Split so every guard is testable without a PTY, and so
// this file stays small enough to audit: it is the one place in the app where SPEECH becomes bytes
// on someone's command line.
//
// ══ IT TYPES. IT DOES NOT SUBMIT. ═══════════════════════════════════════════════════════════════
// `pasteIntoPty`, never `submitPrompt`. The phrase lands on the agent's input line and stops there;
// the human reads it and presses Enter. This is the deliberate difference from every other send path
// in the app, and it is not a conservatism to be tuned away later: with a hot mic in Speak mode, the
// speaker may be a passer-by, a phone call, or a video — auto-submitting any of those into a live
// agent runs a command nobody chose to run. The human's Enter is the consent.
import { PtyGoneError, pasteIntoPty } from "../pty";
import { usePresenceStore } from "../stores/presenceStore";
import { useInteractionStore } from "../stores/interactionStore";
import {
  classifyTerminalRoute,
  type TerminalRouteRefusal,
} from "../voice/dictationTerminalRoute";
import { focusedTerminalAgentId } from "../voice/dictationFocus";
import { agentCanAcceptInput } from "./conciergeDispatch";
import { getAgentViewport } from "./terminalViewport";

/** What actually happened to a phrase. Returned (not thrown) so a caller can render a receipt for
 *  every arm — a refusal the user never sees is indistinguishable from dictation being broken. */
export type TerminalDeliveryOutcome =
  | { kind: "delivered"; agentId: string; text: string }
  | { kind: "refused"; agentId: string | null; reason: TerminalRouteRefusal }
  /** The guards passed but the write itself failed — a dead PTY. Distinct from `refused`: nothing
   *  chose this, and the honest receipt is "it didn't land", not "I declined". */
  | { kind: "failed"; agentId: string; error: unknown };

/** Overridable seams, so the whole path is testable without a DOM, xterm, or a live PTY. Production
 *  passes none of these. */
export interface TerminalSinkDeps {
  focusedAgentId?: () => string | null;
  canAcceptInput?: (agentId: string) => boolean;
  viewport?: typeof getAgentViewport;
  write?: (agentId: string, text: string) => Promise<void>;
}

/**
 * Route ONE COMMITTED phrase to the focused agent's terminal.
 *
 * Committed only — the caller must never hand this interim transcription. A live preview is
 * rewritten word by word as the recognizer changes its mind, and streaming that into a PTY would
 * type, and partly execute, text the speaker never finished saying.
 *
 * LOG HYGIENE: the transcript is never logged, here or anywhere downstream — only its length and the
 * agent id (PRD/sparkle/dictation-no-raw-transcript-in-logs.md). Dictation captures whatever was said
 * near the microphone, which is not all of it meant for a log file.
 */
export async function routeDictationToTerminal(
  phrase: string,
  deps: TerminalSinkDeps = {},
): Promise<TerminalDeliveryOutcome> {
  const focusedAgentId = deps.focusedAgentId ?? focusedTerminalAgentId;
  const canAcceptInput = deps.canAcceptInput ?? agentCanAcceptInput;
  const readViewport = deps.viewport ?? getAgentViewport;
  const write = deps.write ?? pasteIntoPty;

  const agentId = focusedAgentId();
  if (!agentId) return { kind: "refused", agentId: null, reason: "no-terminal" };

  const verdict = classifyTerminalRoute({
    text: phrase,
    writable: canAcceptInput(agentId),
    // THE VIEWPORT, NOT THE SCROLLBACK. Reading history here would refuse forever after the agent's
    // first approval prompt — see services/terminalViewport.ts.
    viewport: readViewport(agentId),
  });
  if (verdict.kind === "refuse") {
    return { kind: "refused", agentId, reason: verdict.reason };
  }

  try {
    await write(agentId, verdict.text);
  } catch (e) {
    // PtyGoneError is the expected shape; anything else is still a failed write and reported the
    // same way. Never swallowed — a phrase the user watched disappear needs a reason.
    if (!(e instanceof PtyGoneError)) console.warn("[dictation] terminal write failed", agentId);
    return { kind: "failed", agentId, error: e };
  }

  // THE USER IS PRESENT. Every OTHER `noteInput` feeder is keystroke-only — do not restate which
  // ones here; ConciergeHost's mount-gate block owns the list, and a named copy in this file is the
  // very thing that has already drifted twice. What matters at this call site is the PROPERTY, not
  // the roster: someone who drives an agent purely by voice would otherwise look idle to the
  // presence timer and trip IDLE_AWAY_MS mid-conversation, after which the concierge starts
  // behaving as if nobody is watching. Dictating is input; say so.
  //
  // THIS LINE IS THEREFORE THE THIRD FEEDER, and the only one that is not a keystroke. Say it that
  // way rather than "fed by onData" — which was never true, not even before this call existed:
  // ComposeBox's `onChange` feeder landed in f03d9f66b (2026-07-27), three days ahead of this one in
  // e41eed4a1 (2026-07-30), so the single-feeder claim was already wrong the day it was written and
  // this call only made it wrong twice over. ConciergeHost's mount-gate block owns the authoritative
  // enumeration; reasoning built on the short count has had to be corrected once (roborev 60344).
  // Note the scope: this fires for a dictated delivery into a TERMINAL, so it does not cover a
  // dictated CONCIERGE send, which is why that path still needs its own inference.
  //
  // Poked AFTER the write so a refused or failed phrase does not count as activity the user never
  // actually produced.
  usePresenceStore.getState().noteInput();
  useInteractionStore.getState().touch(agentId);

  return { kind: "delivered", agentId, text: verdict.text };
}
