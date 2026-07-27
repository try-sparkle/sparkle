// The Concierge column's public contract (bead sparkle-9z3y / CM-U1). This component is
// PURELY presentational: it renders a view-model and reports every user gesture through the
// controller callbacks. The integration unit (U7, sparkle-qd80) owns building the view-model
// from real app state and giving the callbacks effects — nothing in this directory reads a
// store, fetches data, or writes to a PTY.

import type { ReactNode } from "react";
import type { StatusBand } from "../../engine/buildSections";
// The attachment RECORD is the one the removed AgentPane composer used (components/composer/
// attachments.ts) — a pure, React-free, Tauri-free model, so importing it here does not break this
// directory's "presentational only" rule, and it keeps the concierge off a parallel model.
import type { Attachment } from "../composer/attachments";

// The column speaks the app's ONE status vocabulary — "Needs you" / "Running" / "Done" — rather
// than a private P0/P1 scale. Re-exported so consumers of this module's public surface don't have
// to reach into the engine for the type of a field they're already handed.
export type { StatusBand };

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
  /** The source agent's band. Every nudge surfaced today is `needs_you` (that IS the surfacing
   *  gate); the field is carried rather than assumed so the card labels itself from data. */
  band: StatusBand;
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
  /** A BRAIN REPLY, i.e. something worth reading aloud — only these get a speaker button.
   *  The host posts plenty of other `sparkle` lines that are bookkeeping, not speech ("Sent to
   *  CI Hardening.", "…terminal has closed — that didn't send.", the deferred-outcome
   *  reconciliations): offering to read those aloud, and letting `speakingMessageId` point at
   *  one, is not what "exactly one REPLY reads as active" meant (roborev 48172).
   *
   *  REQUIRED, not optional (roborev 52363): defaulting to "not a reply" would let a future
   *  brain-reply producer forget the flag and silently lose the speaker button — a missing
   *  affordance, the hardest kind of regression to notice. Every construction site must decide. */
  speakable: boolean;
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

/** Re-exported so consumers of the column's contract get the attachment shape from one place. */
export type { Attachment };

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
  /** Why no agent target is offered even though an agent IS selected (e.g. a cloud agent takes
   *  prompts in its terminal). Drives the disabled toggle's title/aria so the user isn't told to
   *  "select an agent" they already selected. */
  unavailableReason?: string;
}

/** Everything the column renders, supplied by the integration layer. */
export interface ConciergeViewModel {
  /** Pinned → "Pinned to <name>" in gold; absent → "Following all projects". */
  scope: { pinnedProjectName?: string };
  /** In-scope per-band counts. Nothing needing you and nothing running renders "all calm" —
   *  see ScopeVitals.vitalsParts for why `done` is not a vital sign. */
  vitals: Record<StatusBand, number>;
  /** Pre-formatted spend text for the top-right pill (e.g. "$4.12"). */
  spend: { amountText: string };
  /** The thread, oldest first. Nudges are messages of kind "nudge". */
  messages: ConciergeMessage[];
  /** True while Sparkle is composing a reply — renders the typing indicator row. */
  typing?: boolean;
  /** Where a send goes and which agent it would reach. Omitted → the box only talks to Sparkle. */
  send?: ConciergeSendState;
  /** Files riding along with the NEXT send (parity row #21), rendered as removable chips above the
   *  compose row. The integration layer owns the list; the box only reports removals. */
  attachments?: Attachment[];
  /** True while a native file drag is over the compose box — lights the drop affordance. The
   *  webview drag event is window-global, so only the integration layer can hit-test it. */
  dropActive?: boolean;
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
  /** Drop one staged attachment by id. Optional: a column mounted without attachments has none. */
  onRemoveAttachment?(id: string): void;
  /** Whole-card click: open the nudge's source project/agent. */
  onNudgeClick(nudge: ConciergeNudge): void;
  /** An action button on the card; never accompanied by onNudgeClick. */
  onNudgeAction(nudge: ConciergeNudge, actionId: string): void;
  /** The speaker button on a Sparkle reply: speak it now, or stop if it is the one playing.
   *  Optional — omit it and no reply renders a speaker at all (voice is an opt-in surface). */
  onSpeak?(message: ConciergeSparkleMessage): void;
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
  /** Live, uncommitted dictation transcript for the compose box; "" when nothing is being said. */
  interim?: string;
  /** Handed straight to the compose box so the integration layer can receive committed segments.
   *  Must be referentially stable. */
  registerInsert?: (append: ((text: string) => void) | null) => void;
  /** The id of the reply currently being spoken, so exactly one speaker button reads as active. */
  speakingMessageId?: string | null;
  /** The user typed or deleted in the compose box (not a dictated segment, not the send clear). */
  onTextEdit?: (text: string) => void;
  /** The last FINISHED line for the thread's hidden live region — a completed reply or a status
   *  notice. Never a streaming chunk: the region would then re-announce on every delta. */
  announcement?: ConciergeAnnouncement;
}

/** One write to the column's live region. `seq` is a monotonic WRITE COUNTER, not data — it exists
 *  so an IDENTICAL repeat is still a distinct write (roborev 53392). An `aria-live` region only
 *  speaks when its content CHANGES, so passing the text alone made two consecutive identical lines
 *  ("Sent to CI Hardening." on each of two sends to the same pinned agent) announce exactly once:
 *  React bails out of an `Object.is`-equal setState, and even re-rendered the text node is
 *  unchanged. The column keys the rendered node on `seq`, which turns every write into a real DOM
 *  mutation for the assistive technology to notice. */
export interface ConciergeAnnouncement {
  seq: number;
  text: string;
}
