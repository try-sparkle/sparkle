// A draft handed to THE CONCIERGE COMPOSE BOX from somewhere that isn't the box: today the capture
// takeover's Build ❯ / Chat ❯ and a file drop on "+ New Build Agent". Text plus already-resolved
// attachments, consumed once and NEVER auto-sent — the user reviews it and hits Enter.
//
// WHY THIS STORE EXISTS AT ALL (it replaced handoffStore.buildDraft). The capture window used to
// hand its draft to `handoffStore.buildDraft`, whose only consumer was the terminal Composer inside
// AgentPane. Commit db29f0a48 removed that composer — the concierge box is the input surface for a
// build agent now — so from that commit until this one, sending a screenshot + narration from the
// island CREATED the agent and then wrote the words into a store with no reader. They vanished with
// no error and, worse, ZERO log output, which is why nobody noticed. Two rules follow, and both are
// load-bearing rather than stylistic:
//
//   1. THE CONSUMER LOGS EVERY DELIVERY (ConciergeHost). A handoff that lands says so. That is the
//      only reason a future re-homing of the compose box fails loudly instead of silently.
//   2. THERE IS EXACTLY ONE CONSUMER. `take()` reads AND clears in one call, so a second reader —
//      or a replay of the same effect under StrictMode/HMR — gets null rather than a double-apply.
//      Don't add a plain `get`; the clearing read is the idempotency guard.
//
// Transient by construction (no persistence): the attachments are temp-file paths that a relaunch
// would turn into broken chips, and an unsent draft is not worth resurrecting a week later.
import { create } from "zustand";
import type { CaptureAttachment } from "../capture/types";
import { log } from "../logger";

/** Where the handoff came from. Purely diagnostic — it is what the delivery log names, so a drop
 *  can be traced back to the surface that produced it.
 *
 *  `bead-chat` is the bead card's Chat button (services/beadChat.ts, bead sparkle-1cpomd). It is
 *  the first origin that is NOT a capture, which is why the replacement warning below no longer
 *  says "capture": a drop there discards a draft the founder started by clicking a task, and a log
 *  line naming the wrong surface is how a real loss gets read as somebody else's bug. */
export type ComposeHandoffOrigin =
  | "capture-build"
  | "capture-chat"
  | "new-build-agent-drop"
  | "bead-chat";

export interface ComposeHandoff {
  origin: ComposeHandoffOrigin;
  /** The project the capture was aimed at. Diagnostic — the concierge box is cross-project, so
   *  this does not gate delivery; it is what makes a misrouted capture readable in the log. */
  projectId: string;
  /** The build agent the send was routed into, when the capture named one (capture-build). */
  agentId?: string;
  /** Draft text. May be empty — a screenshot alone is a sendable message (see ComposeBox.canSend). */
  text: string;
  /** Shots/files already resolved by the producer, dataUrl included. Staged as chips as-is rather
   *  than re-read from disk: the capture window already holds the bytes. */
  attachments: CaptureAttachment[];
  /** Send this to SPARKLE, bypassing the auto-router. Set by capture Chat, whose whole point is
   *  that the user chose the concierge over an agent. Only ever "sparkle": forcing the terminal
   *  direction is irreversible, and conciergeRouter's header explains why nothing may. */
  route?: "sparkle";
}

interface ComposeHandoffState {
  handoff: ComposeHandoff | null;
  /** Queue a draft for the compose box. A second call before the first is consumed REPLACES it —
   *  the user produced a newer draft and that is the one they are looking at.
   *
   *  THE REPLACEMENT IS LOGGED, because it discards whatever the displaced surface produced — a
   *  whole capture (narration AND screenshot), or a bead reference the founder clicked for — and is
   *  the last path in this flow that could lose user work without saying so. It is reachable
   *  whenever the consuming effect has not run yet — two sends while the owning window is still
   *  hidden, before `focusThisWindow()`, or a second bead's Chat clicked before the first draft
   *  reached the box. Every producer has already logged "handed off" for the draft being dropped,
   *  so without this line the log positively asserts a delivery that never happened, which is worse
   *  than silence (roborev 53836). */
  set: (h: ComposeHandoff) => void;
  /** Read AND clear. The clearing is the point — see the header. */
  take: () => ComposeHandoff | null;
  /** Drop an unconsumed handoff without delivering it (teardown / tests). */
  clear: () => void;
}

export const useComposeHandoffStore = create<ComposeHandoffState>()((set, get) => ({
  handoff: null,
  set: (h) => {
    const displaced = get().handoff;
    if (displaced) {
      // Kinds and counts, never paths or the text itself — this log ships with support tickets.
      // NOT "a capture handoff" — `bead-chat` is not a capture, and the dropped surface is already
      // named in `droppedOrigin`. A message that hard-codes one producer misattributes every other
      // one's loss to a window the user never opened.
      log.warn("composer", "a compose handoff was replaced before it was ever delivered", {
        droppedOrigin: displaced.origin,
        droppedProjectId: displaced.projectId,
        droppedChars: displaced.text.length,
        droppedAttachments: displaced.attachments.length,
        replacedByOrigin: h.origin,
      });
    }
    set({ handoff: h });
  },
  take: () => {
    const h = get().handoff;
    if (h) set({ handoff: null });
    return h;
  },
  clear: () => set({ handoff: null }),
}));
