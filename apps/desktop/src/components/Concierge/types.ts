// The Concierge column's public contract (bead sparkle-9z3y / CM-U1). This component is
// PURELY presentational: it renders a view-model and reports every user gesture through the
// controller callbacks. The integration unit (U7, sparkle-qd80) owns building the view-model
// from real app state and giving the callbacks effects — nothing in this directory reads a
// store, fetches data, or writes to a PTY.

import type { ReactNode } from "react";

export type ConciergePriority = "p0" | "p1";

/** One clickable action button on a nudge card ("Show me", "Auto-fix", "Park it", …). */
export interface ConciergeNudgeAction {
  id: string;
  label: string;
  /** Visual weight, per the prototype: primary = gold-tinted, ghost = muted; default = plain. */
  kind?: "primary" | "ghost";
}

/** A cross-project alert card in the thread. The WHOLE card is clickable (→ onNudgeClick,
 *  "open the source project/agent"); its action buttons fire onNudgeAction and never bubble
 *  into the card click. */
export interface ConciergeNudge {
  id: string;
  kind: "nudge";
  priority: ConciergePriority;
  /** The project chip ("drodio-website") — how a cross-project alert names its origin. */
  projectName: string;
  /** The agent the alert came from ("OG Image Pipeline"). */
  agentName: string;
  /** What Sparkle says about it, with the recommendation. */
  text: string;
  actions: ConciergeNudgeAction[];
}

/** Right-aligned user bubble. No "You" label — alignment + bubble chrome carry authorship. */
export interface ConciergeUserMessage {
  id: string;
  kind: "you";
  text: string;
}

/** Left-aligned plain Sparkle reply. No "Sparkle" label, no glow — just warm text. */
export interface ConciergeSparkleMessage {
  id: string;
  kind: "sparkle";
  text: string;
}

/** A thin centered divider line ("All projects calm · nothing needs you"). */
export interface ConciergeBatchMessage {
  id: string;
  kind: "batch";
  text: string;
}

export type ConciergeMessage =
  | ConciergeUserMessage
  | ConciergeSparkleMessage
  | ConciergeBatchMessage
  | ConciergeNudge;

/** Drives the star-field wordmark: still firefly drift at rest, buzzy waveform while the
 *  user is talking (listening) or Sparkle is typing a reply (speaking). */
export type WordmarkMode = "idle" | "listening" | "speaking";

export type ConciergeAttachKind = "screenshot" | "image" | "files";

/** Where the compose box's next send goes. The concierge box is the app's ONLY composer (CM-U7),
 *  so it has to serve both jobs the user has: talking to Sparkle itself ("sparkle" — the headless
 *  brain), and sending a prompt straight into the selected agent's terminal ("agent" — what the
 *  removed AgentPane composer did). The target is explicit rather than inferred: a guess here
 *  either drops a prompt into a chat or fires a real agent turn the user didn't ask for. */
export type ConciergeSendTarget = "sparkle" | "agent";

/** The compose box's send-target affordance. `agentName` absent → there is no agent to send to
 *  (no project / no selected agent), and the toggle renders disabled on "sparkle". */
export interface ConciergeSendState {
  target: ConciergeSendTarget;
  agentName?: string;
}

/** Everything the column renders, supplied by the integration layer. */
export interface ConciergeViewModel {
  /** Pinned → "Pinned to <name>" in gold; absent → "Following all projects". */
  scope: { pinnedProjectName?: string };
  /** In-scope attention counts; both zero renders "all calm". */
  vitals: { p0: number; p1: number };
  /** Pre-formatted spend text for the top-right pill (e.g. "$4.12"). */
  spend: { amountText: string };
  /** The thread, oldest first. Nudges are messages of kind "nudge". */
  messages: ConciergeMessage[];
  /** True while Sparkle is composing a reply — renders the typing indicator row. */
  typing?: boolean;
  /** Where a send goes and which agent it would reach. Omitted → the box only talks to Sparkle. */
  send?: ConciergeSendState;
}

/** Every gesture the column can emit. The integration layer supplies all of these. */
export interface ConciergeController {
  /** The user submitted trimmed non-empty text (Send button or ⌘/Ctrl+Enter). The integration
   *  layer routes it by the CURRENT `model.send.target` — the column never decides.
   *
   *  May return a promise resolving FALSE when the send did not land; the compose box then puts
   *  the draft back rather than making the user retype it. Returning nothing means "assume it
   *  landed" (the chat path, which can't fail visibly). */
  onSend(text: string): void | Promise<boolean>;
  /** Flip the compose box between talking to Sparkle and prompting the selected agent. Optional:
   *  a column mounted without a send state has nothing to toggle. */
  onToggleSendTarget?(): void;
  onMicToggle(): void;
  onAttach(kind: ConciergeAttachKind): void;
  /** Whole-card click: open the nudge's source project/agent. */
  onNudgeClick(nudge: ConciergeNudge): void;
  /** An action button on the card; never accompanied by onNudgeClick. */
  onNudgeAction(nudge: ConciergeNudge, actionId: string): void;
}

export interface ConciergeColumnProps {
  model: ConciergeViewModel;
  controller: ConciergeController;
  /** Mic armed/live — tints the mic button and (unless overridden) buzzes the wordmark. */
  micLive?: boolean;
  /** Explicit wordmark drive; defaults to listening while micLive, speaking while typing. */
  wordmarkMode?: WordmarkMode;
  /** Column width in px (the shell is fixed-width; the workspace owns resizing). */
  width?: number;
  /** Optional affordance rendered under the scope/vitals line — the shell drops the ⌘K palette
   *  trigger here (PRD §4: history search lives in the concierge). */
  searchSlot?: ReactNode;
}
